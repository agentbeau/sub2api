import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { publishCiArtifacts } from "./publish-ci-artifacts.mjs";

const revision = "a".repeat(40);
const repository = { id: 1453664051, full_name: "agentbeau/sub2api" };
const prefix = "/repos/agentbeau/sub2api";
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const clone = value => globalThis.structuredClone(value);

function fixture() {
  const run = {
    id: 101, run_attempt: 2, workflow_id: 345, path: ".github/workflows/ci.yml",
    event: "push", head_branch: "main", head_sha: revision,
    status: "completed", conclusion: "success", repository: clone(repository), head_repository: clone(repository),
  };
  const blobs = new Map([[501, Buffer.from("PK original tested Worker ZIP\n")], [502, Buffer.from("PK original tested image ZIP\n")]]);
  const artifacts = ["container-worker", "container-image"].map((name, i) => ({
    id: 501 + i, name, size_in_bytes: blobs.get(501 + i).length, digest: sha256(blobs.get(501 + i)), expired: false,
    workflow_run: { id: 101, repository_id: 1453664051, head_repository_id: 1453664051, head_branch: "main", head_sha: revision },
  }));
  const state = {
    run, artifacts, blobs, main: revision, workflow: { id: 345, path: ".github/workflows/ci.yml", state: "active" },
    release: null, assets: [], uploads: new Map(), writes: [], requests: [], failUpload: "", afterUpload: null,
  };
  const fetcher = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const headers = new globalThis.Headers(options.headers);
    state.requests.push({ url: url.href, method, headers });
    if (url.hostname === "artifact-storage.example") {
      assert.equal(headers.get("authorization"), null, "signed storage downloads must not receive the GitHub token");
      return new Response(state.blobs.get(Number(url.pathname.slice(1))));
    }
    assert.equal(headers.get("authorization"), "Bearer automatic-test-token");
    assert.ok(["api.github.com", "uploads.github.com"].includes(url.hostname));
    const path = url.pathname;
    if (method === "GET") {
      if (path === `${prefix}/actions/workflows/ci.yml`) return Response.json(clone(state.workflow));
      if (path === `${prefix}/actions/runs/101`) return Response.json(clone(state.run));
      if (path === `${prefix}/git/ref/heads/main`) return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: state.main } });
      if (path === `${prefix}/actions/runs/101/artifacts`) return Response.json({ total_count: state.artifacts.length, artifacts: clone(state.artifacts) });
      if (/\/actions\/artifacts\/\d+\/zip$/.test(path)) {
        const id = Number(path.split("/").at(-2));
        return new Response(null, { status: 302, headers: { location: `https://artifact-storage.example/${id}` } });
      }
      if (path.startsWith(`${prefix}/releases/tags/`)) return state.release && !state.release.draft ? Response.json(clone(state.release)) : new Response(null, { status: 404 });
      if (path === `${prefix}/releases`) return Response.json(state.release ? [clone(state.release)] : []);
      if (path.startsWith(`${prefix}/git/ref/tags/`)) return state.release && !state.release.draft
        ? Response.json({ object: { type: "commit", sha: revision } }) : new Response(null, { status: 404 });
      if (path === `${prefix}/releases/71/assets`) return Response.json(clone(state.assets));
    }
    if (method === "POST" && path === `${prefix}/releases`) {
      const body = JSON.parse(options.body);
      state.writes.push({ method, path, body });
      if (state.release) return new Response(null, { status: 422 });
      state.release = { id: 71, ...body };
      return Response.json(clone(state.release), { status: 201 });
    }
    if (method === "POST" && url.hostname === "uploads.github.com" && path === `${prefix}/releases/71/assets`) {
      const name = url.searchParams.get("name");
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      state.writes.push({ method, path, name });
      if (state.failUpload === name) {
        state.failUpload = "";
        return new Response(null, { status: 503 });
      }
      assert.equal(state.assets.some(asset => asset.name === name), false, "publisher must not replace an existing asset");
      const asset = { id: 801 + state.assets.length, name, size: bytes.length, digest: sha256(bytes), state: "uploaded" };
      state.assets.push(asset);
      state.uploads.set(name, bytes);
      state.afterUpload?.(name);
      return Response.json(clone(asset), { status: 201 });
    }
    if (method === "PATCH" && path === `${prefix}/releases/71`) {
      const body = JSON.parse(options.body);
      state.writes.push({ method, path, body });
      Object.assign(state.release, body);
      return Response.json(clone(state.release));
    }
    throw new Error(`Unexpected publication request: ${method} ${url}`);
  };
  return { state, options: { runId: 101, runAttempt: 2, revision, token: "automatic-test-token", fetcher } };
}

test("publication distributes the original tested ZIP bytes and publishes only the complete draft", async () => {
  const f = fixture();
  const result = await publishCiArtifacts(f.options);
  assert.equal(result.tag, `sub2api-ci-${revision}-101-2`);
  assert.equal(f.state.release.target_commitish, revision);
  assert.equal(f.state.release.prerelease, true);
  assert.equal(f.state.release.make_latest, "false");
  assert.equal(f.state.release.draft, false);
  assert.deepEqual(f.state.uploads.get("container-worker.zip"), Buffer.from("PK original tested Worker ZIP\n"));
  assert.deepEqual(f.state.uploads.get("container-image.zip"), Buffer.from("PK original tested image ZIP\n"));
  const receipt = JSON.parse(f.state.uploads.get("receipt.json"));
  assert.equal(receipt.revision, revision);
  assert.equal(receipt.runId, 101);
  assert.equal(receipt.runAttempt, 2);
  assert.deepEqual(receipt.artifacts.map(a => [a.name, a.id, a.assetName]), [
    ["container-worker", 501, "container-worker.zip"], ["container-image", 502, "container-image.zip"],
  ]);
  assert.equal(f.state.writes.at(-1).method, "PATCH");
  assert.deepEqual(f.state.assets.map(a => a.name), ["container-worker.zip", "container-image.zip", "receipt.json"]);
});

test("untrusted or stale API run data is rejected before any release write", async () => {
  const cases = [
    f => { f.state.run.event = "pull_request"; },
    f => { f.state.run.head_repository.id = 22; },
    f => { f.state.run.repository.full_name = "someone/sub2api"; },
    f => { f.state.run.path = ".github/workflows/other.yml"; },
    f => { f.state.run.workflow_id = 44; },
    f => { f.state.run.run_attempt = 3; },
    f => { f.state.main = "b".repeat(40); },
    f => { f.state.artifacts.pop(); },
  ];
  for (const change of cases) {
    const f = fixture();
    change(f);
    await assert.rejects(publishCiArtifacts(f.options));
    assert.deepEqual(f.state.writes, []);
  }
});

test("corrupt or truncated source ZIPs cannot create a draft release", async () => {
  for (const bytes of [Buffer.from("wrong bytes"), Buffer.alloc(29, 120)]) {
    const f = fixture();
    f.state.blobs.set(501, bytes);
    await assert.rejects(publishCiArtifacts(f.options), /size|digest|SHA|checksum/i);
    assert.deepEqual(f.state.writes, []);
  }
});

test("same-name artifacts from multiple CI attempts fail clearly instead of choosing the newest", async () => {
  const f = fixture();
  f.state.artifacts.push({ ...clone(f.state.artifacts[0]), id: 777 });
  await assert.rejects(publishCiArtifacts(f.options), /ambiguous.*CI/i);
  assert.deepEqual(f.state.writes, []);
});

test("retrying a completed publication verifies it without any writes", async () => {
  const f = fixture();
  await publishCiArtifacts(f.options);
  f.state.writes = [];
  const result = await publishCiArtifacts(f.options);
  assert.equal(result.reused, true);
  assert.deepEqual(f.state.writes, []);
});

test("an interrupted draft resumes missing uploads without replacing its matching assets", async () => {
  const f = fixture();
  f.state.failUpload = "container-image.zip";
  await assert.rejects(publishCiArtifacts(f.options), /503/);
  assert.equal(f.state.release.draft, true);
  assert.deepEqual(f.state.assets.map(asset => asset.name), ["container-worker.zip"]);
  const firstAsset = clone(f.state.assets[0]);
  f.state.writes = [];
  await publishCiArtifacts(f.options);
  assert.deepEqual(f.state.assets[0], firstAsset);
  assert.equal(f.state.release.draft, false);
  assert.deepEqual(f.state.writes.filter(write => write.name).map(write => write.name), ["container-image.zip", "receipt.json"]);
});

test("a mismatched draft or published asset is never overwritten", async () => {
  for (const draft of [true, false]) {
    const f = fixture();
    await publishCiArtifacts(f.options);
    f.state.release.draft = draft;
    f.state.assets[0].digest = `sha256:${"0".repeat(64)}`;
    f.state.writes = [];
    await assert.rejects(publishCiArtifacts(f.options), /asset|digest|checksum/i);
    assert.deepEqual(f.state.writes, []);
  }
});

test("advancing main, rerunning CI, or changing source metadata after upload leaves the draft unpublished", async () => {
  const changes = [
    state => { state.main = "b".repeat(40); },
    state => { state.run.run_attempt = 3; },
    state => { state.artifacts[0].digest = `sha256:${"0".repeat(64)}`; },
    state => { state.artifacts.pop(); },
  ];
  for (const change of changes) {
    const f = fixture();
    f.state.afterUpload = name => { if (name === "receipt.json") change(f.state); };
    await assert.rejects(publishCiArtifacts(f.options));
    assert.equal(f.state.release.draft, true);
    assert.equal(f.state.writes.some(write => write.method === "PATCH"), false);
  }
});

test("the read-only workflow gate checks API identity before emitting a checkout revision", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/publish-artifacts.yml", import.meta.url), "utf8"));
  const gate = workflow.jobs.validate.steps.find(step => step.id === "source");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("github", "context", "core", gate.with.script);
  for (const invalid of [false, true]) {
    const f = fixture();
    if (invalid) f.state.run.head_repository.id = 0;
    const outputs = {};
    const github = { rest: {
      actions: {
        getWorkflow: async () => ({ data: f.state.workflow }),
        getWorkflowRun: async () => ({ data: f.state.run }),
      },
      git: { getRef: async () => ({ data: { ref: "refs/heads/main", object: { type: "commit", sha: f.state.main } } }) },
    } };
    const invocation = execute(github, { payload: { workflow_run: { id: 101 } } }, { setOutput: (key, value) => { outputs[key] = String(value); } });
    if (invalid) {
      await assert.rejects(invocation);
      assert.deepEqual(outputs, {});
    } else {
      await invocation;
      assert.deepEqual(outputs, { revision, run_id: "101", run_attempt: "2" });
    }
  }
  assert.equal(workflow.jobs.validate.permissions.contents, "read");
  assert.equal(workflow.jobs.validate.permissions.actions, "read");
  assert.equal(workflow.jobs.publish.needs, "validate");
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
  const checkout = workflow.jobs.publish.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ needs.validate.outputs.revision }}");
  assert.equal(checkout.with["persist-credentials"], false);
});
