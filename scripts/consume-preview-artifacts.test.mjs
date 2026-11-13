import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { consumeCiArtifacts, verifyCiProvenance } from "./consume-preview-artifacts.mjs";
import { ARTIFACT_NAMES, CI_WORKFLOW, REPOSITORY, REPOSITORY_ID, artifactReleaseTag, createReleaseReceipt } from "./preview-github-artifacts.mjs";
import { writeManifest } from "./deployment-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "a".repeat(40);
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const zipScript = "import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [z.write(f,str(f.relative_to(p))) for f in sorted(p.rglob('*')) if f.is_file()]; z.close()";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-consume-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = { id: 123, run_attempt: 1, workflow_id: 456, path: CI_WORKFLOW, head_sha: revision, head_branch: "dagul/isolated-worker-preview", event: "push", status: "completed", conclusion: "success", repository: { id: REPOSITORY_ID, full_name: REPOSITORY }, head_repository: { id: REPOSITORY_ID, full_name: REPOSITORY } };
  const artifacts = [];
  const assets = [];
  const bytes = new Map();
  for (const [index, name] of ARTIFACT_NAMES.entries()) {
    const source = join(directory, name);
    await mkdir(source);
    if (name === "isolated-preview") {
      await mkdir(join(source, "worker"));
      await writeFile(join(source, "worker/index.js"), "export default {};\n");
      await writeFile(join(source, "wrangler.json"), '{"name":"sub2api"}');
      await writeManifest(source, { revision, dirty: false, install: "isolated-preview" });
    } else {
      await writeFile(join(source, "image.tar.gz"), "exact tested image archive");
      await writeFile(join(source, "management.html"), "<title>sub2api Console</title>");
      await writeManifest(source, { revision, dirty: false, install: "container-image", image: `sub2api-cpa:${revision.slice(0, 12)}-1-1`, imageId: `sha256:${"b".repeat(64)}` });
    }
    const archive = join(directory, `${name}.zip`);
    execFileSync("python3", ["-c", zipScript, source, archive]);
    const payload = await readFile(archive);
    artifacts.push({ id: 200 + index, name, digest: digest(payload), size_in_bytes: payload.length, expired: false, workflow_run: { id: run.id, repository_id: REPOSITORY_ID, head_repository_id: REPOSITORY_ID, head_branch: "dagul/isolated-worker-preview", head_sha: revision } });
    assets.push({ id: 300 + index, name: `${name}.zip`, size: payload.length, digest: digest(payload), state: "uploaded" });
    bytes.set(300 + index, payload);
  }
  const receipt = createReleaseReceipt(run, artifacts);
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  assets.push({ id: 302, name: "receipt.json", size: receiptBytes.length, digest: digest(receiptBytes), state: "uploaded" });
  bytes.set(302, receiptBytes);
  const release = { id: 999, draft: false, prerelease: true, tag_name: artifactReleaseTag(run), target_commitish: revision, assets };
  const state = { calls: [], commands: [], clock: 0, runWaits: 0, releaseWaits: 0, tagSha: revision, missingArtifact: false, changedAttempt: false };
  const fetcher = async (url, options) => {
    assert.ok(!Object.keys(options.headers).some(name => /authorization/i.test(name)));
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.github.com");
    const path = parsed.pathname.replace(`/repos/${REPOSITORY}`, "");
    state.calls.push(path);
    if (path === "/actions/workflows/ci.yml") return Response.json({ id: 456, path: CI_WORKFLOW, state: "active" });
    if (path === "/actions/workflows/ci.yml/runs") {
      assert.equal(parsed.searchParams.get("head_sha"), revision);
      return Response.json({ workflow_runs: state.runWaits-- > 0 ? [] : [run] });
    }
    if (path.startsWith("/releases/tags/")) return state.releaseWaits-- > 0 ? new Response(null, { status: 404 }) : Response.json(release);
    if (path.startsWith("/git/ref/tags/")) return Response.json({ object: { type: "commit", sha: state.tagSha } });
    if (path.startsWith("/releases/assets/")) return new Response(bytes.get(Number(path.split("/").at(-1))));
    if (path.startsWith("/actions/artifacts/")) return state.missingArtifact ? new Response(null, { status: 404 }) : Response.json(artifacts.find(item => item.id === Number(path.split("/").at(-1))));
    if (path === `/actions/runs/${run.id}`) return Response.json({ ...run, run_attempt: state.changedAttempt ? 2 : run.run_attempt });
    throw new Error(`Unexpected anonymous GitHub request ${path}`);
  };
  const output = join(directory, "received");
  const options = {
    root, revision, directory: output, worker: join(output, "worker"), image: join(output, "image"), env: { PATH: process.env.PATH }, fetcher,
    now: () => state.clock, sleep: async ms => { state.clock += ms; },
    execute: (command, args, settings) => { state.commands.push({ command, args }); return execFileSync(command, args, settings); },
  };
  return { options, state, run, artifacts, assets, bytes, receipt, release, directory };
}

test("consumer verifies original ZIP digests, extracts real archives and never rebuilds or starts containers", async (t) => {
  const f = await fixture(t);
  f.artifacts[0].expired = true; // Available immutable metadata still proves the published bytes.
  const source = await consumeCiArtifacts(f.options);
  assert.deepEqual(source, f.receipt);
  assert.equal(await readFile(join(f.options.image, "image.tar.gz"), "utf8"), "exact tested image archive");
  assert.deepEqual(f.state.commands.map(call => call.command), ["python3", "python3"]);
  assert.equal(f.state.calls.some(path => path.includes("/latest")), false);
  assert.deepEqual(await verifyCiProvenance(source, revision, { fetcher: f.options.fetcher }), source);
});

test("wrong source workflow, repository, event, result or revision cannot reach extraction", async (t) => {
  for (const patch of [{ path: ".github/workflows/other.yml" }, { workflow_id: 789 }, { repository: { id: 1, full_name: REPOSITORY } }, { head_repository: { id: REPOSITORY_ID, full_name: "fork/sub2api" } }, { conclusion: "failure" }, { event: "pull_request" }, { head_sha: "f".repeat(40) }]) {
    const f = await fixture(t);
    Object.assign(f.run, patch);
    await assert.rejects(consumeCiArtifacts({ ...f.options, timeoutMs: 2, pollMs: 1 }));
    assert.equal(f.state.commands.length, 0);
    assert.equal(f.state.calls.some(path => path.startsWith("/releases/assets/")), false);
  }
});

test("release changes cannot substitute different bytes for original Actions ZIPs", async (t) => {
  for (const tamper of ["payload", "digest", "source", "tag", "receipt", "incomplete"]) {
    const f = await fixture(t);
    if (tamper === "payload") f.bytes.set(300, Buffer.alloc(f.bytes.get(300).length));
    if (tamper === "digest") f.assets[0].digest = `sha256:${"e".repeat(64)}`;
    if (tamper === "source") f.artifacts[0].workflow_run.id = 456;
    if (tamper === "tag") f.state.tagSha = "e".repeat(40);
    if (tamper === "receipt") {
      f.receipt.runAttempt = 2;
      const changed = Buffer.from(JSON.stringify(f.receipt));
      f.bytes.set(302, changed);
      Object.assign(f.assets[2], { digest: digest(changed), size: changed.length });
    }
    if (tamper === "incomplete") f.release.assets = f.assets.slice(0, 2);
    await assert.rejects(consumeCiArtifacts(f.options));
    assert.equal(f.state.commands.length, 0);
  }
});

test("changed attempts and missing original provenance fail closed with a rerun path", async (t) => {
  for (const failure of ["changedAttempt", "missingArtifact"]) {
    const f = await fixture(t);
    f.state[failure] = true;
    await assert.rejects(consumeCiArtifacts(f.options), /attempt changed|metadata expired or was removed/);
    assert.equal(f.state.commands.length, 0);
  }
  const f = await fixture(t);
  f.state.changedAttempt = true;
  await assert.rejects(verifyCiProvenance(f.receipt, revision, { fetcher: f.options.fetcher }), /attempt changed/);
});

test("waiting uses one polling endpoint at a time and times out before producing artifacts", async (t) => {
  const f = await fixture(t);
  f.state.runWaits = 1;
  f.state.releaseWaits = 1;
  await consumeCiArtifacts(f.options);
  assert.equal(f.state.clock, 60_000);
  assert.equal(f.state.calls.filter(path => path.endsWith("/runs")).length, 2);
  assert.equal(f.state.calls.filter(path => path.startsWith("/releases/tags/")).length, 2);
  const timeout = await fixture(t);
  timeout.state.runWaits = 100;
  await assert.rejects(consumeCiArtifacts({ ...timeout.options, timeoutMs: 90_000 }), /Timed out/);
  assert.equal(timeout.state.clock, 90_000);
  assert.equal(timeout.state.commands.length, 0);
});

test("ZIP extraction refuses traversal, links, duplicate entries and oversized file lists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-zip-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const kind of ["traversal", "absolute", "link", "duplicate", "many"]) {
    const archive = join(directory, `${kind}.zip`);
    const output = join(directory, kind);
    const make = "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); k=sys.argv[2]; i=zipfile.ZipInfo('../outside' if k=='traversal' else '/outside' if k=='absolute' else 'file'); i.external_attr=(0o120777<<16) if k=='link' else (0o100644<<16); z.writestr(i,'data'); [z.writestr('file' if k=='duplicate' else str(n),'data') for n in range(256 if k=='many' else 1 if k=='duplicate' else 0)]; z.close()";
    execFileSync("python3", ["-W", "ignore", "-c", make, archive, kind]);
    assert.throws(() => execFileSync("python3", ["scripts/extract-ci-artifact.py", archive, output], { cwd: root, stdio: "pipe" }));
    await assert.rejects(readFile(join(directory, "outside")), { code: "ENOENT" });
  }
});
