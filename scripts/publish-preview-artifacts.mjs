import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_NAMES, CI_WORKFLOW, REPOSITORY, artifactReleaseTag,
  createReleaseReceipt, validateArtifact, validateRun,
} from "./preview-github-artifacts.mjs";

const PREFIX = `/repos/${REPOSITORY}`;
const RECEIPT_ASSET = "receipt.json";
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function githubClient(token, fetcher) {
  const headers = {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "sub2api-artifact-publisher",
  };
  async function request(path, { method = "GET", body, optional = false } = {}) {
    const response = await fetcher(`https://api.github.com${PREFIX}${path}`, {
      method, headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(60_000),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
    return response.json();
  }
  async function download(artifact, file) {
    const response = await fetcher(`https://api.github.com${PREFIX}/actions/artifacts/${artifact.id}/zip`, {
      headers, redirect: "manual", signal: AbortSignal.timeout(60_000),
    });
    if (response.status !== 302) throw new Error(`GitHub artifact download failed (${response.status})`);
    const location = new URL(response.headers.get("location"));
    if (location.protocol !== "https:" || location.username || location.password) throw new Error("Unsafe artifact download redirect");
    // The signed storage URL is fetched without GitHub or deployment credentials.
    const archive = await fetcher(location.href, {
      headers: { Accept: "application/octet-stream" }, redirect: "follow", signal: AbortSignal.timeout(300_000),
    });
    if (!archive.ok || !archive.body) throw new Error(`Artifact storage download failed (${archive.status})`);
    const hash = createHash("sha256");
    let size = 0;
    const check = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > artifact.size_in_bytes) return callback(new Error(`Artifact ${artifact.name} exceeds its checked size`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(archive.body), check, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    if (size !== artifact.size_in_bytes || `sha256:${hash.digest("hex")}` !== artifact.digest) {
      throw new Error(`Artifact ${artifact.name} size or SHA256 digest mismatch`);
    }
  }
  async function upload(releaseId, asset) {
    const url = new URL(`https://uploads.github.com${PREFIX}/releases/${releaseId}/assets`);
    url.searchParams.set("name", asset.name);
    const body = createReadStream(asset.file);
    try {
      const response = await fetcher(url.href, {
        method: "POST", headers: { ...headers, "Content-Type": asset.name.endsWith(".zip") ? "application/zip" : "application/json", "Content-Length": String(asset.size) },
        body, duplex: "half", redirect: "error", signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`GitHub asset upload ${asset.name} failed (${response.status})`);
      return response.json();
    } finally {
      body.destroy();
    }
  }
  return { request, download, upload };
}

async function checkedSource(client, { runId, runAttempt, revision }) {
  const [workflow, run, main, listing] = await Promise.all([
    client.request("/actions/workflows/ci.yml"), client.request(`/actions/runs/${runId}`),
    client.request("/git/ref/heads/dagul/isolated-worker-preview"), client.request(`/actions/runs/${runId}/artifacts?per_page=100`),
  ]);
  if (workflow.path !== CI_WORKFLOW || workflow.state !== "active" || !positiveInteger(workflow.id)) throw new Error("Unexpected source CI workflow");
  validateRun(run, revision, workflow.id);
  if (run.id !== runId || run.run_attempt !== runAttempt) throw new Error("Source CI run or attempt changed");
  if (main.ref !== "refs/heads/dagul/isolated-worker-preview" || main.object?.type !== "commit" || main.object.sha !== revision) throw new Error("Source revision is no longer current preview branch");
  if (!Array.isArray(listing.artifacts) || listing.total_count !== listing.artifacts.length || listing.artifacts.length > 100) throw new Error("Incomplete source artifact metadata");
  const artifacts = ARTIFACT_NAMES.map(name => {
    const matches = listing.artifacts.filter(artifact => artifact.name === name);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous ${name} artifacts; a fresh complete CI run is required`);
    return validateArtifact(matches[0], run, name);
  });
  return { run, artifacts, receipt: `${JSON.stringify(createReleaseReceipt(run, artifacts), null, 2)}\n` };
}

function checkAsset(actual, expected) {
  if (!positiveInteger(actual?.id) || actual.name !== expected.name || actual.state !== "uploaded" ||
      actual.size !== expected.size || actual.digest !== expected.digest) {
    throw new Error(`Release asset ${expected.name} does not match its tested source; refusing to overwrite it`);
  }
}

function checkAssetSet(actual, expected, complete = false) {
  if (!Array.isArray(actual) || actual.length > expected.length) throw new Error("Unexpected release assets");
  const seen = new Set();
  for (const asset of actual) {
    const match = expected.find(item => item.name === asset.name);
    if (!match || seen.has(asset.name)) throw new Error("Unexpected or duplicate release asset");
    checkAsset(asset, match);
    seen.add(asset.name);
  }
  if (complete && seen.size !== expected.length) throw new Error("Release artifact set is incomplete");
  return seen;
}

async function checkTag(client, tag, revision, required = false) {
  const ref = await client.request(`/git/ref/tags/${encodeURIComponent(tag)}`, { optional: !required });
  if (ref && (ref.object?.type !== "commit" || ref.object.sha !== revision)) throw new Error("Existing release tag targets another revision");
}

async function findRelease(client, tag) {
  const published = await client.request(`/releases/tags/${encodeURIComponent(tag)}`, { optional: true });
  if (published) return published;
  // The by-tag endpoint documents published releases only. List releases with
  // write authorization to find an interrupted draft instead of creating a duplicate.
  for (let page = 1; page <= 100; page += 1) {
    const releases = await client.request(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases) || releases.length > 100) throw new Error("Invalid GitHub release listing");
    const matches = releases.filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error("Ambiguous existing CI artifact release");
    if (matches.length === 1) return matches[0];
    if (releases.length < 100) return null;
  }
  throw new Error("Unable to establish whether this CI artifact release already exists");
}

export async function publishCiArtifacts({ runId, runAttempt, revision, token, fetcher = fetch }) {
  if (!positiveInteger(runId) || !positiveInteger(runAttempt) || !/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("A validated CI run ID, attempt, and full revision are required");
  if (typeof token !== "string" || !token.trim()) throw new Error("The workflow's automatic GITHUB_TOKEN is required");
  const client = githubClient(token, fetcher);
  const parameters = { runId, runAttempt, revision };
  const source = await checkedSource(client, parameters);
  const tag = artifactReleaseTag(source.run);
  const directory = await mkdtemp(join(tmpdir(), "sub2api-publish-"));
  try {
    const assets = [];
    for (const artifact of source.artifacts) {
      const name = `${artifact.name}.zip`;
      const file = join(directory, name);
      await client.download(artifact, file);
      assets.push({ name, file, size: artifact.size_in_bytes, digest: artifact.digest });
    }
    const receiptFile = join(directory, RECEIPT_ASSET);
    await writeFile(receiptFile, source.receipt, { mode: 0o600 });
    assets.push({ name: RECEIPT_ASSET, file: receiptFile, size: Buffer.byteLength(source.receipt), digest: digest(source.receipt) });
    const refreshed = await checkedSource(client, parameters);
    if (refreshed.receipt !== source.receipt) throw new Error("Source artifact metadata changed before publication");
    let release = await findRelease(client, tag);
    await checkTag(client, tag, revision, release?.draft === false);
    if (release && (!positiveInteger(release.id) || release.tag_name !== tag || release.target_commitish !== revision ||
        release.prerelease !== true || typeof release.draft !== "boolean")) throw new Error("Existing release does not match this checked CI run");
    if (!release) {
      release = await client.request("/releases", { method: "POST", body: {
        tag_name: tag, target_commitish: revision, name: `sub2api CI artifacts ${revision}`,
        body: `Original tested archives from ${REPOSITORY} CI run ${runId}, attempt ${runAttempt}.`,
        draft: true, prerelease: true, make_latest: "false",
      } });
      if (!positiveInteger(release.id) || release.draft !== true || release.tag_name !== tag) throw new Error("GitHub did not create the expected draft release");
    }
    const existing = await client.request(`/releases/${release.id}/assets?per_page=100`);
    const present = checkAssetSet(existing, assets, !release.draft);
    if (!release.draft) return { tag, releaseId: release.id, reused: true };
    for (const asset of assets) {
      if (!present.has(asset.name)) checkAsset(await client.upload(release.id, asset), asset);
    }
    checkAssetSet(await client.request(`/releases/${release.id}/assets?per_page=100`), assets, true);
    await checkTag(client, tag, revision);
    const finalSource = await checkedSource(client, parameters);
    if (finalSource.receipt !== source.receipt) throw new Error("Source artifact metadata changed before publication");
    const published = await client.request(`/releases/${release.id}`, { method: "PATCH", body: { draft: false, prerelease: true, make_latest: "false" } });
    if (published.id !== release.id || published.draft !== false || published.tag_name !== tag) throw new Error("GitHub did not confirm publication of the checked release");
    return { tag, releaseId: release.id, reused: false };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REPOSITORY !== REPOSITORY) {
      throw new Error("Artifact publication must run in the validated repository workflow");
    }
    const result = await publishCiArtifacts({
      runId: Number(process.env.SUB2API_CI_RUN_ID), runAttempt: Number(process.env.SUB2API_CI_RUN_ATTEMPT),
      revision: process.env.SUB2API_CI_REVISION, token: process.env.GITHUB_TOKEN,
    });
    console.log(`Verified CI artifact release: ${result.tag}${result.reused ? " (already published)" : ""}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
