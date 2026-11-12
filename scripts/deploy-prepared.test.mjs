import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCurrentMain } from "./current-main.mjs";
import { deployPrepared } from "./deploy-prepared.mjs";
import { artifactConfig, writeManifest } from "./deployment-artifact.mjs";

const revision = "a".repeat(40);
const account = "b".repeat(32);
const image = `sub2api-cpa:${revision.slice(0, 12)}-1-1`;
const imageId = `sha256:${"c".repeat(64)}`;
const digest = `registry.cloudflare.com/${account}/sub2api-cpa@sha256:${"d".repeat(64)}`;

async function fixture(t, install = "container") {
  const root = await mkdtemp(join(tmpdir(), "sub2api-prepared-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, "artifact");
  const images = join(root, "image");
  await mkdir(join(worker, "worker"), { recursive: true });
  await mkdir(images);
  const config = artifactConfig({
    name: "sub2api", main: "src/index.ts",
    ...(install === "container" ? {
      containers: [{ class_name: "Cpa", image: "./container/Dockerfile" }],
      r2_buckets: [{ binding: "STATE", bucket_name: "sub2api" }],
    } : {}),
  }, install);
  await writeFile(join(worker, "worker/index.js"), "export default {};\n");
  await writeFile(join(worker, "wrangler.json"), JSON.stringify(config));
  await writeManifest(worker, { revision, dirty: false, install });
  await writeFile(join(images, "image.tar.gz"), "checked image fixture");
  await writeFile(join(images, "management.html"), "<title>sub2api Console</title>");
  await writeManifest(images, { revision, dirty: false, install: "container-image", image, imageId });
  const environment = {
    CHECKED_SHA: revision, SUB2API_EXPECTED_MAIN_SHA: revision,
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "deploy-secret",
    GITHUB_OUTPUT: join(root, "github-output"),
    PATH: "/usr/bin", HTTPS_PROXY: "http://proxy:8080", GITHUB_TOKEN: "github-secret",
  };
  const state = { calls: [], main: revision, checks: 0, moveAfter: "", failCheck: 0 };
  const execute = (command, args, options) => {
    state.calls.push({ command, args, ...options });
    if (command === "git" && args[0] === "rev-parse") return revision;
    if (command === "git" && args[0] === "ls-remote") {
      state.checks += 1;
      if (state.checks === state.failCheck) throw new Error("public main unavailable");
      return `${state.main}\trefs/heads/main\n`;
    }
    if (args[0]?.endsWith("live-install.mjs")) return install;
    if (command === "docker" && args[1] === "load") return "";
    if (command === "docker" && args[1] === "inspect") return args[3] === "{{.Id}}" ? imageId : JSON.stringify([digest]);
    if (command.endsWith("/wrangler")) {
      if (args[0] === "containers" && args[1] === "push") {
        if (state.moveAfter === "push") state.main = "e".repeat(40);
        return "";
      }
      if (args[0] === "r2" && args[1] === "object" && args[2] === "put") {
        if (state.moveAfter === "panel") state.main = "e".repeat(40);
        return "";
      }
      if (args[0] === "deploy") return "https://sub2api.example.workers.dev\n";
    }
    throw new Error(`Unexpected command in prepared deployment: ${command} ${args.join(" ")}`);
  };
  const fetcher = async (url) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/sub2api`);
    return Response.json({ success: true });
  };
  return { args: [install, worker, images], options: { root, environment, execute, fetcher }, worker, state };
}

function writes(state) {
  return state.calls.filter(call => call.command.endsWith("/wrangler")).map(call => call.args[0] === "r2" ? "panel" : call.args[0]);
}

test("opted-in deployment checks main after image push and immediately before activation", async (t) => {
  const f = await fixture(t);
  await deployPrepared(f.args, f.options);
  const operations = f.state.calls.filter(call => call.command.endsWith("/wrangler") || call.args[0] === "ls-remote").map(call => call.args[0] === "ls-remote" ? "main" : call.args[0] === "r2" ? "panel" : call.args[0]);
  assert.deepEqual(operations, ["containers", "main", "panel", "main", "deploy"]);
  for (const call of f.state.calls.filter(call => call.args[0] === "ls-remote")) {
    assert.deepEqual(call.args, ["ls-remote", "--exit-code", "https://github.com/agentbeau/sub2api.git", "refs/heads/main"]);
    assert.equal(call.env.HTTPS_PROXY, "http://proxy:8080");
    assert.equal(call.env.GIT_TERMINAL_PROMPT, "0");
    assert.ok(!JSON.stringify(call.env).includes("secret"));
  }
  await assert.rejects(readFile(join(f.worker, "deploy.json")), { code: "ENOENT" });
});

test("main advancing during image publication stops before the panel and Worker writes", async (t) => {
  const f = await fixture(t);
  f.state.moveAfter = "push";
  await assert.rejects(deployPrepared(f.args, f.options), /no longer current main/);
  assert.deepEqual(writes(f.state), ["containers"]);
  assert.equal(f.state.checks, 1);
});

test("main advancing after panel publication stops Worker activation and cleans its temporary config", async (t) => {
  const f = await fixture(t);
  f.state.moveAfter = "panel";
  await assert.rejects(deployPrepared(f.args, f.options), /no longer current main/);
  assert.deepEqual(writes(f.state), ["containers", "panel"]);
  assert.equal(f.state.checks, 2);
  await assert.rejects(readFile(join(f.worker, "deploy.json")), { code: "ENOENT" });
});

test("a failed public main lookup fails closed at either late gate", async (t) => {
  for (const gate of [1, 2]) {
    const f = await fixture(t);
    f.state.failCheck = gate;
    await assert.rejects(deployPrepared(f.args, f.options), /public main unavailable/);
    assert.deepEqual(writes(f.state), gate === 1 ? ["containers"] : ["containers", "panel"]);
    await assert.rejects(readFile(join(f.worker, "deploy.json")), { code: "ENOENT" });
  }
});

test("ordinary prepared deployments keep their original behavior without opting in", async (t) => {
  for (const install of ["container", "worker"]) {
    const f = await fixture(t, install);
    delete f.options.environment.SUB2API_EXPECTED_MAIN_SHA;
    f.state.main = "e".repeat(40);
    f.state.failCheck = 1;
    await deployPrepared(f.args, f.options);
    assert.equal(f.state.checks, 0);
    assert.deepEqual(writes(f.state), install === "container" ? ["containers", "panel", "deploy"] : ["deploy"]);
    assert.equal(await readFile(f.options.environment.GITHUB_OUTPUT, "utf8"), "url=https://sub2api.example.workers.dev\n");
  }
});

test("an explicitly invalid or different expected-main revision is rejected before writes", async (t) => {
  for (const expected of ["", "short", "e".repeat(40)]) {
    const f = await fixture(t);
    f.options.environment.SUB2API_EXPECTED_MAIN_SHA = expected;
    await assert.rejects(deployPrepared(f.args, f.options), /expected main revision/);
    assert.deepEqual(writes(f.state), []);
  }
});

test("the shared public-main check rejects malformed or ambiguous responses", async () => {
  for (const remote of ["", `${revision}\trefs/heads/other`, `${revision}\trefs/heads/main\n${"e".repeat(40)}\trefs/heads/main`]) {
    await assert.rejects(checkCurrentMain("/tmp", revision, {}, () => remote), /no longer current main/);
  }
  await assert.rejects(checkCurrentMain("/tmp", "short", {}, () => { throw new Error("should not run"); }), /full expected main revision/);
});
