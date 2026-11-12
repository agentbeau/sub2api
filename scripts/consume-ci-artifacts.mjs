import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ARTIFACT_NAMES, CI_WORKFLOW, REPOSITORY, REPOSITORY_ID, artifactReleaseTag, validateArtifact, validateReleaseReceipt, validateRun } from "./github-artifacts.mjs";
import { verifyArtifact, verifyContainerImageArtifact } from "./deployment-artifact.mjs";

const API = `https://api.github.com/repos/${REPOSITORY}`;
const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "sub2api-verified-artifacts", "X-GitHub-Api-Version": "2022-11-28" };
export const WAIT_LIMIT_MS = 12 * 60 * 1000;
export const POLL_INTERVAL_MS = 30 * 1000;

function requestSignal(deadline, now, maximum = 30_000) {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("Timed out waiting for verified GitHub artifacts; production is unchanged. Rerun CI and the Cloudflare build.");
  return AbortSignal.timeout(Math.max(1, Math.min(maximum, remaining)));
}

async function github(path, context, allowMissing = false) {
  const response = await context.fetcher(`${API}${path}`, { headers: HEADERS, signal: requestSignal(context.deadline, context.now) });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`Public GitHub provenance lookup failed (HTTP ${response.status}); rerun CI if its original metadata expired or was removed`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error("GitHub provenance response exceeded its size limit");
  return JSON.parse(body);
}

async function pause(context, message) {
  console.log(message);
  requestSignal(context.deadline, context.now);
  await context.sleep(Math.min(context.pollMs, context.deadline - context.now()));
}

function validateWorkflow(workflow) {
  if (!Number.isSafeInteger(workflow?.id) || workflow.id <= 0 || workflow.path !== CI_WORKFLOW || workflow.state !== "active") throw new Error("The trusted GitHub ci.yml workflow is unavailable");
  return workflow.id;
}

async function waitForRun(revision, workflowId, context) {
  const query = new URLSearchParams({ event: "push", branch: "main", head_sha: revision, per_page: "10" });
  while (true) {
    const result = await github(`/actions/workflows/ci.yml/runs?${query}`, context);
    if (!Array.isArray(result.workflow_runs)) throw new Error("GitHub returned no workflow run collection");
    const candidates = result.workflow_runs.filter(run => run.head_sha === revision && run.event === "push" && run.head_branch === "main");
    candidates.sort((a, b) => b.id - a.id);
    const run = candidates[0];
    if (run?.status === "completed") return validateRun(run, revision, workflowId);
    if (run && (run.repository?.id !== REPOSITORY_ID || run.head_repository?.id !== REPOSITORY_ID || run.workflow_id !== workflowId || run.path !== CI_WORKFLOW)) throw new Error("Untrusted source workflow run");
    await pause(context, `Waiting for the trusted main CI run for ${revision}.`);
  }
}

async function waitForRelease(run, context) {
  const tag = artifactReleaseTag(run);
  while (true) {
    const release = await github(`/releases/tags/${tag}`, context, true);
    if (release) {
      if (release.draft || !release.prerelease || release.tag_name !== tag || release.target_commitish !== run.head_sha || !Array.isArray(release.assets)) throw new Error("Unexpected published CI artifact release");
      const names = release.assets.map(asset => asset.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(["container-image.zip", "container-worker.zip", "receipt.json"])) throw new Error("Published release is incomplete or has unexpected assets");
      return release;
    }
    await pause(context, `Waiting for published CI artifacts from run ${run.id}, attempt ${run.run_attempt}.`);
  }
}

async function downloadAsset(asset, path, digest, size, context) {
  if (!Number.isSafeInteger(asset?.id) || asset.id <= 0 || asset.state !== "uploaded" || asset.size !== size || asset.digest !== digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Release asset does not match its verified size and digest");
  const response = await context.fetcher(`${API}/releases/assets/${asset.id}`, {
    headers: { ...HEADERS, Accept: "application/octet-stream" }, signal: requestSignal(context.deadline, context.now, 120_000),
  });
  if (!response.ok || !response.body) throw new Error(`Public release download failed (HTTP ${response.status})`);
  const hash = createHash("sha256");
  let bytes = 0;
  const checking = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > size) return callback(new Error("Release download exceeded its expected size"));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), checking, createWriteStream(path, { flags: "wx", mode: 0o600 }));
    if (bytes !== size || `sha256:${hash.digest("hex")}` !== digest) throw new Error("Release ZIP bytes differ from their original Actions artifact");
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export async function verifyCiProvenance(source, revision, { fetcher = fetch, now = Date.now } = {}) {
  const context = { fetcher, now, deadline: now() + 120_000 };
  if (!source || source.revision !== revision || source.repository !== REPOSITORY || source.repositoryId !== REPOSITORY_ID || !Number.isSafeInteger(source.runId) || !Array.isArray(source.artifacts) || source.artifacts.length !== ARTIFACT_NAMES.length) throw new Error("Missing original GitHub CI provenance receipt");
  const [workflow, run] = await Promise.all([github("/actions/workflows/ci.yml", context), github(`/actions/runs/${source.runId}`, context)]);
  validateRun(run, revision, validateWorkflow(workflow));
  if (run.run_attempt !== source.runAttempt) throw new Error("The source CI run attempt changed; rerun the Cloudflare build");
  const artifacts = await Promise.all(source.artifacts.map(artifact => {
    if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0) throw new Error("Invalid original artifact ID");
    return github(`/actions/artifacts/${artifact.id}`, context);
  }));
  return validateReleaseReceipt(source, run, artifacts);
}

export async function consumeCiArtifacts({ root, revision, worker, image, directory, env, execute, fetcher = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = WAIT_LIMIT_MS, pollMs = POLL_INTERVAL_MS }) {
  const context = { fetcher, now, sleep, pollMs, deadline: now() + timeoutMs };
  const workflowId = validateWorkflow(await github("/actions/workflows/ci.yml", context));
  const run = await waitForRun(revision, workflowId, context);
  const release = await waitForRelease(run, context);
  const tag = await github(`/git/ref/tags/${artifactReleaseTag(run)}`, context);
  if (tag.object?.type !== "commit" || tag.object.sha !== revision) throw new Error("CI artifact release tag does not resolve to the verified commit");
  const receiptAsset = release.assets.find(asset => asset.name === "receipt.json");
  if (!Number.isSafeInteger(receiptAsset.size) || receiptAsset.size <= 0 || receiptAsset.size > 16 * 1024) throw new Error("Unexpected published receipt size");
  const downloads = join(directory, "downloads");
  await mkdir(downloads, { recursive: true });
  const receiptPath = join(downloads, "receipt.json");
  await downloadAsset(receiptAsset, receiptPath, receiptAsset.digest, receiptAsset.size, context);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== ARTIFACT_NAMES.length) throw new Error("Missing published artifact provenance");
  const artifacts = await Promise.all(receipt.artifacts.map(artifact => {
    if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0) throw new Error("Invalid original artifact ID");
    return github(`/actions/artifacts/${artifact.id}`, context);
  }));
  const source = validateReleaseReceipt(receipt, run, artifacts);
  await Promise.all(source.artifacts.map(async artifact => {
    validateArtifact(artifacts.find(item => item.id === artifact.id), run, artifact.name);
    const asset = release.assets.find(item => item.name === artifact.assetName);
    await downloadAsset(asset, join(downloads, artifact.assetName), artifact.digest, artifact.size, context);
  }));
  // Check again after the downloads so a rerun cannot silently change provenance.
  const currentRun = await github(`/actions/runs/${run.id}`, context);
  validateRun(currentRun, revision, workflowId);
  if (currentRun.run_attempt !== run.run_attempt) throw new Error("The source CI run attempt changed during download");
  for (const artifact of source.artifacts) {
    const destination = artifact.name === "container-worker" ? worker : image;
    await execute("python3", ["scripts/extract-ci-artifact.py", join(downloads, artifact.assetName), destination], { cwd: root, env });
  }
  await verifyArtifact(worker, revision, "container");
  await verifyContainerImageArtifact(image, revision);
  console.log(`Consumed exact GitHub CI artifacts from run ${run.id}, attempt ${run.run_attempt}; no container rebuild or startup.`);
  return source;
}
