import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEnvironment, buildMetadata, runPhase } from "./cloudflare-builds.mjs";
import { writeManifest } from "./deployment-artifact.mjs";

const revision = "a".repeat(40);
const account = "b".repeat(32);
const uuid = "27ba2102-88c9-4f3c-8073-4c4bcfdcc770";
const environment = {
  WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", WORKERS_CI_COMMIT_SHA: revision,
  WORKERS_CI_BUILD_UUID: uuid, SKIP_DEPENDENCY_INSTALL: "1", CLOUDFLARE_ACCOUNT_ID: account,
  PATH: "/usr/bin", HOME: "/home/build", CLOUDFLARE_API_TOKEN: "deploy-secret",
  DASHBOARD_PASSWORD: "dashboard-secret", SUB2API_MANAGEMENT_KEY: "management-secret",
  GITHUB_TOKEN: "github-secret", NPM_TOKEN: "npm-secret", FUTURE_SECRET: "future-secret",
  SUB2API_EXPECTED_MAIN_SHA: "f".repeat(40),
  WRANGLER_CI_MATCH_TAG: "c".repeat(32), WRANGLER_CI_OVERRIDE_NAME: "sub2api",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sub2api-builds-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { calls: [], consumed: 0, head: revision, main: revision, dirty: "", live: "container", fail: "" };
  const execute = async (command, args, options) => {
    state.calls.push({ command, args, ...options });
    const label = [command, ...args].join(" ");
    if (state.fail && label.includes(state.fail)) throw new Error("injected gate failure");
    if (command === "git") {
      if (args[0] === "rev-parse") return state.head;
      if (args[0] === "status") return state.dirty;
      if (args[0] === "ls-remote") return `${state.main}\trefs/heads/main\n`;
    }
    if (args[0]?.endsWith("live-install.mjs")) return state.live;
    if (args[0]?.endsWith("deploy-prepared.mjs")) return "https://sub2api.example.workers.dev";
    return "";
  };
  const source = { revision, runId: 123, runAttempt: 1 };
  const consume = async ({ worker, image, env }) => {
    state.consumed += 1;
    state.calls.push({ command: "consume-ci-artifacts", args: [], env });
    if (state.fail === "consume-ci-artifacts") throw new Error("injected gate failure");
    await mkdir(join(worker, "worker"), { recursive: true });
    await writeFile(join(worker, "worker/index.js"), "export default {};");
    await writeFile(join(worker, "wrangler.json"), '{"name":"sub2api"}');
    await writeManifest(worker, { revision, dirty: false, install: "container" });
    await mkdir(image, { recursive: true });
    await writeFile(join(image, "image.tar.gz"), "checked image fixture");
    await writeFile(join(image, "management.html"), "<title>sub2api Console</title>");
    await writeManifest(image, { revision, dirty: false, install: "container-image", image: `sub2api-cpa:${revision.slice(0, 12)}-1-1`, imageId: `sha256:${"d".repeat(64)}` });
    return source;
  };
  const verifySource = async receipt => {
    if (state.fail === "source-provenance") throw new Error("original source provenance changed");
    assert.deepEqual(receipt, source);
  };
  return { root, environment: { ...environment }, execute, consume, verifySource, state };

}

test("build metadata refuses previews, missing platform identities and automatic dependency installation", () => {
  assert.deepEqual(buildMetadata(environment), { revision, buildUuid: uuid, account });
  for (const patch of [
    { WORKERS_CI: "" }, { WORKERS_CI_BRANCH: "feature" }, { WORKERS_CI_COMMIT_SHA: "short" },
    { WORKERS_CI_BUILD_UUID: "../escape" }, { SKIP_DEPENDENCY_INSTALL: "" },
    { CLOUDFLARE_ACCOUNT_ID: "" }, { WRANGLER_CI_OVERRIDE_NAME: "another-worker" },
    { WRANGLER_CI_MATCH_TAG: "invalid" },
  ]) assert.throws(() => buildMetadata({ ...environment, ...patch }));
});

test("child build environments allow only build inputs, preserve network trust and exclude every deployment secret", () => {
  const clean = buildEnvironment({ ...environment, HTTPS_PROXY: "http://proxy:8080", SSL_CERT_FILE: "/trusted/ca.pem", DOCKER_HOST: "unix:///run/docker.sock", CPA_VERSION: "v8.0.67" });
  for (const secret of ["deploy-secret", "dashboard-secret", "management-secret", "github-secret", "npm-secret", "future-secret"]) assert.ok(!JSON.stringify(clean).includes(secret));
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "WRANGLER_CI_MATCH_TAG", "WRANGLER_CI_OVERRIDE_NAME", "GITHUB_TOKEN", "NPM_TOKEN", "FUTURE_SECRET", "SUB2API_EXPECTED_MAIN_SHA"]) assert.ok(!(key in clean));
  assert.equal(clean.HTTPS_PROXY, "http://proxy:8080");
  assert.equal(clean.SSL_CERT_FILE, "/trusted/ca.pem");
  assert.equal(clean.DOCKER_HOST, "unix:///run/docker.sock");
  assert.equal(clean.CPA_VERSION, "v8.0.67");
  assert.equal(clean.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
});

test("build consumes checked CI artifacts and runs packaged gates without giving credentials to a child", async (t) => {
  const f = await fixture(t);
  const result = await runPhase("build", f);
  assert.equal(f.state.consumed, 1);
  const calls = f.state.calls.map(x => [x.command, ...x.args].join(" "));
  const order = ["npm ci", "--test", "consume-ci-artifacts", "test:runtime"];
  let previous = -1;
  for (const gate of order) { const at = calls.findIndex(x => gate === "consume-ci-artifacts" ? x === gate : x.includes(gate)); assert.ok(at > previous, gate); previous = at; }
  assert.ok(calls.every(x => !x.includes("deploy-prepared.mjs")));
  for (const call of f.state.calls) {
    assert.ok(!JSON.stringify(call.env).includes("deploy-secret"));
    assert.ok(!("WRANGLER_CI_MATCH_TAG" in call.env));
  }
  const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
  assert.equal(receipt.revision, revision);
  assert.equal(receipt.buildUuid, uuid);
  assert.equal(receipt.account, account);
  assert.match(receipt.workerManifest, /^[a-f0-9]{64}$/);
  assert.match(receipt.imageManifest, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.source, { revision, runId: 123, runAttempt: 1 });
  assert.ok(calls.every(command => !/docker|cargo|build-container-image|prepare-deployment/.test(command)));

});

test("failed dependency setup, provenance or packaged runtime cannot leave a successful build receipt", async (t) => {
  for (const gate of ["npm ci", "test:runtime", "consume-ci-artifacts"]) {
    const f = await fixture(t);
    await runPhase("build", f);
    f.state.fail = gate;
    await assert.rejects(runPhase("build", f), /injected gate failure/);
    await assert.rejects(readFile(join(f.root, ".wrangler/cloudflare-builds", uuid, "passed.json")), { code: "ENOENT" });
    assert.ok(f.state.calls.every(x => !x.args[0]?.endsWith("deploy-prepared.mjs")));
  }
});

test("dirty and stale source fails before dependencies or artifact consumption", async (t) => {
  for (const patch of [{ dirty: " M src/index.ts" }, { head: "e".repeat(40) }, { main: "f".repeat(40) }]) {
    const f = await fixture(t);
    Object.assign(f.state, patch);
    await assert.rejects(runPhase("build", f));
    assert.equal(f.state.consumed, 0);
    assert.ok(f.state.calls.every(x => x.command === "git"));
  }
});

test("deployment rechecks artifacts and only supplies the deploy token to the installation guard and prepared deploy", async (t) => {
  const f = await fixture(t);
  await runPhase("build", f);
  f.state.calls = [];
  await runPhase("deploy", f);
  const credentialCalls = f.state.calls.filter(x => x.env.CLOUDFLARE_API_TOKEN);
  assert.equal(credentialCalls.length, 2);
  assert.ok(credentialCalls[0].args[0].endsWith("live-install.mjs"));
  assert.ok(credentialCalls[1].args[0].endsWith("deploy-prepared.mjs"));
  for (const call of credentialCalls) {
    assert.equal(call.env.CHECKED_SHA, revision);
    assert.equal(call.env.SUB2API_EXPECTED_MAIN_SHA, revision);
    assert.equal(call.env.WRANGLER_CI_MATCH_TAG, environment.WRANGLER_CI_MATCH_TAG);
    assert.equal(call.env.WRANGLER_CI_OVERRIDE_NAME, "sub2api");
    assert.ok(!JSON.stringify(call.env).includes("dashboard-secret"));
    assert.ok(!JSON.stringify(call.env).includes("management-secret"));
    assert.ok(!JSON.stringify(call.env).includes("future-secret"));
  }
  assert.ok(f.state.calls.at(-3).args.includes("refs/heads/main"));
  assert.ok(f.state.calls.at(-1).args[0].endsWith("check-deployed.mjs"));
  assert.ok(!f.state.calls.at(-1).env.CLOUDFLARE_API_TOKEN);
  assert.equal(f.state.consumed, 1);
});

test("changed payloads, rewritten manifests and another build receipt cannot deploy", async (t) => {
  for (const tamper of ["payload", "manifest", "build", "account"]) {
    const f = await fixture(t);
    const result = await runPhase("build", f);
    if (tamper === "payload") await writeFile(join(result.worker, "worker/index.js"), "changed");
    if (tamper === "manifest") {
      await writeFile(join(result.worker, "worker/index.js"), "changed");
      await writeManifest(result.worker, { revision, dirty: false, install: "container" });
    }
    if (["build", "account"].includes(tamper)) {
      const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
      receipt[tamper === "build" ? "buildUuid" : "account"] = "other";
      await writeFile(result.receipt, JSON.stringify(receipt));
    }
    f.state.calls = [];
    await assert.rejects(runPhase("deploy", f));
    assert.ok(f.state.calls.every(x => !x.args[0]?.endsWith("deploy-prepared.mjs")));
  }
});

test("stale builds and other gateway installations cannot replace production", async (t) => {
  for (const patch of [{ main: "f".repeat(40) }, { live: "worker" }, { live: "none" }]) {
    const f = await fixture(t);
    await runPhase("build", f);
    Object.assign(f.state, patch);
    f.state.calls = [];
    await assert.rejects(runPhase("deploy", f));
    assert.ok(f.state.calls.every(x => !x.args[0]?.endsWith("deploy-prepared.mjs")));
  }
});

test("validation checks the passed artifacts without credentials, deployment or rebuilding", async (t) => {
  const f = await fixture(t);
  await runPhase("build", f);
  f.environment.CLOUDFLARE_API_TOKEN = "";
  f.state.calls = [];
  await runPhase("validate", f);
  assert.ok(f.state.calls.every(x => x.command === "git"));
  assert.equal(f.state.consumed, 1);
});

test("changed original CI provenance blocks deployment even when local checksums still match", async (t) => {
  const f = await fixture(t);
  await runPhase("build", f);
  f.state.fail = "source-provenance";
  f.state.calls = [];
  await assert.rejects(runPhase("deploy", f), /source provenance changed/);
  assert.ok(f.state.calls.every(call => call.command === "git"));
});
