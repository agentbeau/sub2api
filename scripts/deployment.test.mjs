import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactConfig, deploymentSecrets, imageDigest, sourceIdentity, verifyArtifact, writeManifest } from "./deployment-artifact.mjs";
import { execFileSync } from "node:child_process";
import { checkDeployed } from "./check-deployed.mjs";
import { installationAllowed } from "./check-installation.mjs";

const REVISION = "a".repeat(40);
const IMAGE = `registry.cloudflare.com/${"b".repeat(32)}/sub2api-cpa@sha256:${"c".repeat(64)}`;
const ROOT_CONFIG = {
  name: "sub2api", main: "src/index.ts", build: { command: "npm run build" },
  containers: [{ name: "sub2api", class_name: "Cpa", image: "./container/Dockerfile", image_build_context: "./container", instance_type: "basic", max_instances: 1 }],
  durable_objects: { bindings: [{ name: "CPA", class_name: "Cpa" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Cpa"] }],
  r2_buckets: [{ binding: "STATE", bucket_name: "sub2api" }],
};

test("automatic deployments update only their existing installation and never create the other variant", () => {
  assert.equal(installationAllowed("container", "container", "workflow_run"), true);
  assert.equal(installationAllowed("worker", "worker", "workflow_run"), true);
  assert.equal(installationAllowed("container", "worker", "workflow_run"), false);
  assert.equal(installationAllowed("worker", "container", "workflow_run"), false);
  assert.equal(installationAllowed("none", "container", "workflow_run"), false);
  assert.equal(installationAllowed("none", "worker", "workflow_run"), false);
  assert.equal(installationAllowed("none", "container", "schedule"), false);
  assert.equal(installationAllowed("none", "container", "workflow_dispatch"), true);
  assert.equal(installationAllowed("none", "worker", "workflow_dispatch"), true);
});

test("prepared configuration preserves state identity and cannot rebuild code or the image", () => {
  const config = artifactConfig(ROOT_CONFIG, "container", IMAGE);
  assert.equal(config.main, "./worker/index.js");
  assert.equal(config.build, undefined);
  assert.equal(config.containers[0].image, IMAGE);
  assert.equal(config.containers[0].image_build_context, undefined);
  assert.deepEqual(config.durable_objects, ROOT_CONFIG.durable_objects);
  assert.deepEqual(config.migrations, ROOT_CONFIG.migrations);
  assert.deepEqual(config.r2_buckets, ROOT_CONFIG.r2_buckets);
  assert.equal(ROOT_CONFIG.build.command, "npm run build");
  assert.throws(() => artifactConfig(ROOT_CONFIG, "container", "registry.cloudflare.com/account/cpa:latest"), /digest/);
});

test("worker alternative retains Store while assets move into its artifact", () => {
  const source = { name: "sub2api", main: "src/index.ts", build: { command: "download panel" }, assets: { directory: "public", binding: "ASSETS", run_worker_first: true }, durable_objects: { bindings: [{ name: "STORE", class_name: "Store" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["Store"] }] };
  const config = artifactConfig(source, "worker");
  assert.equal(config.build, undefined);
  assert.equal(config.assets.directory, "./public");
  assert.deepEqual(config.durable_objects, source.durable_objects);
  assert.deepEqual(config.migrations, source.migrations);
  assert.equal(config.containers, undefined);
});

test("artifact verification refuses a different revision, missing bytes, changed bytes, or extra modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-artifact-"));
  try {
    await mkdir(join(directory, "worker"));
    await writeFile(join(directory, "worker/index.js"), "export default {};\n");
    await writeManifest(directory, { revision: REVISION, dirty: false, install: "container" });
    assert.equal((await verifyArtifact(directory, REVISION, "container")).revision, REVISION);
    await assert.rejects(verifyArtifact(directory, "d".repeat(40), "container"), /revision/);
    await assert.rejects(verifyArtifact(directory, REVISION, "worker"), /install/);
    await writeFile(join(directory, "worker/index.js"), "changed\n");
    await assert.rejects(verifyArtifact(directory, REVISION, "container"), /checksum/);
    await writeFile(join(directory, "worker/index.js"), "export default {};\n");
    await writeFile(join(directory, "worker/extra.js"), "export default {};\n");
    await assert.rejects(verifyArtifact(directory, REVISION, "container"), /file set/);
    await rm(join(directory, "worker/extra.js"));
    await rm(join(directory, "worker/index.js"));
    await assert.rejects(verifyArtifact(directory, REVISION, "container"), /file set/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verification does not follow symbolic links or manifest paths outside the artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-artifact-"));
  try {
    await writeFile(join(directory, "module.js"), "safe");
    await writeManifest(directory, { revision: REVISION, dirty: false, install: "worker" });
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    manifest.files["../outside"] = manifest.files["module.js"];
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(verifyArtifact(directory, REVISION, "worker"), /path/);
    await symlink("module.js", join(directory, "linked.js"));
    await assert.rejects(writeManifest(directory, { revision: REVISION, dirty: false, install: "worker" }), /symbolic link/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dirty source artifacts can be inspected locally but are refused for deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-dirty-"));
  try {
    await writeFile(join(directory, "module.js"), "export default {};");
    await writeManifest(directory, { revision: REVISION, dirty: true, install: "container" });
    await assert.rejects(verifyArtifact(directory, REVISION, "container"), /dirty/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("provenance detects tracked, staged and untracked changes while ignoring build output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-provenance-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  try {
    git("init", "--quiet");
    await writeFile(join(directory, "source.js"), "initial");
    await writeFile(join(directory, ".gitignore"), "output/\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
    assert.equal(sourceIdentity(directory).dirty, false);
    await mkdir(join(directory, "output"));
    await writeFile(join(directory, "output/generated.js"), "generated");
    assert.equal(sourceIdentity(directory).dirty, false);
    await writeFile(join(directory, "source.js"), "unstaged");
    assert.equal(sourceIdentity(directory).dirty, true);
    git("add", "source.js");
    assert.equal(sourceIdentity(directory).dirty, true);
    git("reset", "--hard", "HEAD");
    await writeFile(join(directory, "new-source.js"), "untracked");
    assert.equal(sourceIdentity(directory).dirty, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new installations require valid separate secrets while existing secrets stay untouched", () => {
  assert.equal(deploymentSecrets("container", false), null);
  assert.throws(() => deploymentSecrets("container", true), /require both/);
  assert.throws(() => deploymentSecrets("container", true, "x".repeat(32), "x".repeat(32)), /requirements/);
  assert.throws(() => deploymentSecrets("container", true, "!".repeat(32), "y".repeat(32)), /requirements/);
  assert.deepEqual(deploymentSecrets("container", true, "x".repeat(32), "y".repeat(32)), { DASHBOARD_PASSWORD: "x".repeat(32), MANAGEMENT_KEY: "y".repeat(32) });
  assert.deepEqual(deploymentSecrets("worker", true, "password-12345678", "management-12345678"), { DASHBOARD_PASSWORD: "password-12345678", MANAGEMENT_KEY: "management-12345678" });
});

test("image digest selection accepts only the pushed repository in the intended account", () => {
  const account = "b".repeat(32);
  assert.equal(imageDigest(["docker.io/other/image@sha256:" + "e".repeat(64), IMAGE], account, "sub2api-cpa:test"), IMAGE);
  assert.throws(() => imageDigest([IMAGE], "f".repeat(32), "sub2api-cpa:test"), /digest/);
  assert.throws(() => imageDigest([IMAGE], account, "other:test"), /digest/);
  assert.throws(() => imageDigest([IMAGE.replace("@sha256:", ":")], account, "sub2api-cpa:test"), /digest/);
});

function gateway({ authenticated = 200, anonymous = 401, ready = 200, models = { data: [{ id: "example-model" }] } } = {}) {
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/healthz") return Response.json({ status: "ok" });
    if (path === "/readyz") return Response.json({ status: ready === 200 ? "ready" : "starting" }, { status: ready });
    if (path === "/v1/models") {
      const status = options.headers?.authorization === "Bearer probe-key" ? authenticated : anonymous;
      return Response.json(status === 200 ? models : { error: "unauthorized" }, { status });
    }
    throw new Error("unexpected path");
  };
}

test("healthy provider readiness without a key reports authenticated checks as skipped", async () => {
  const result = await checkDeployed({ base: "https://gateway.example", install: "container", fetcher: gateway() });
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, "skipped");
  assert.equal(result.provider, "ready");
});

test("a rejected test credential fails deployment verification despite healthy endpoints", async () => {
  const result = await checkDeployed({ base: "https://gateway.example", install: "container", key: "probe-key", fetcher: gateway({ authenticated: 401 }) });
  assert.equal(result.ok, false);
  assert.equal(result.authenticated, "failed");
});

test("a valid authenticated model list passes, but malformed data or an open gateway fail", async () => {
  const options = { base: "https://gateway.example", install: "container", key: "probe-key" };
  assert.equal((await checkDeployed({ ...options, fetcher: gateway() })).authenticated, "passed");
  assert.equal((await checkDeployed({ ...options, fetcher: gateway({ models: {} }) })).ok, false);
  assert.equal((await checkDeployed({ ...options, fetcher: gateway({ anonymous: 200 }) })).ok, false);
});

test("container readiness failure is not hidden by a passing liveness endpoint", async () => {
  const result = await checkDeployed({ base: "https://gateway.example", install: "container", fetcher: gateway({ ready: 503 }), attempts: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.provider, "failed");
});
