// Exercise the compiled Wasm in workerd, including native streaming and WebSocket responses.
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = resolve(root, ".wrangler/runtime-test");
const password = "runtime-test-password-0123456789abcdef";
const key = "runtime-test-api-key-0123456789abcdef";
await mkdir(temporary, { recursive: true });

async function bundle(entry, output) {
  await build({
    entryPoints: [entry], outfile: output, bundle: true, format: "esm", platform: "neutral",
    target: "esnext", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*"],
    loader: { ".wasm": "copy" }, logLevel: "warning",
  });
}

const artifact = process.argv[2] ? resolve(process.argv[2]) : resolve(temporary, "root/index.js");
if (!process.argv[2]) await bundle(resolve(root, "src/index.ts"), artifact);
const options = async (scriptPath) => ({
  modules: [
    { type: "ESModule", path: scriptPath },
    ...(await readdir(dirname(scriptPath), { recursive: true })).filter(path => path.endsWith(".wasm")).map(path => ({ type: "CompiledWasm", path: resolve(dirname(scriptPath), path) })),
  ],
  modulesRoot: dirname(scriptPath),
  compatibilityDate: "2026-10-01", cf: false,
  bindings: { DASHBOARD_PASSWORD: password, MANAGEMENT_KEY: "runtime-management-key-0123456789abcdef", CONTAINER_IDLE_TIMEOUT_MS: "1000" },
});

const publicWorker = new Miniflare(convertV4MiniflareOptions({
  ...await options(artifact),
  durableObjects: { CPA: { className: "Cpa", useSQLite: true } },
  r2Buckets: ["STATE"],
  ratelimits: { LOGIN_LIMIT: { namespace_id: "1001", simple: { limit: 20, period: 60 } } },
}));
try {
  const health = await publicWorker.dispatchFetch("https://gateway.example/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const form = await publicWorker.dispatchFetch("https://gateway.example/login");
  assert.equal(form.status, 200);
  const loginHtml = await form.text();
  assert.match(loginHtml, /name="password"/);
  assert.match(loginHtml, /<title>Console<\/title>/);
  assert.doesNotMatch(loginHtml, /sub2api|CLIProxyAPI|CPAMC|\bCPA\b/);
  const login = await publicWorker.dispatchFetch("https://gateway.example/login", {
    method: "POST", body: new URLSearchParams({ password }), redirect: "manual",
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Rust login returns a session cookie");
  const home = await publicWorker.dispatchFetch("https://gateway.example/", { headers: { cookie }, redirect: "manual" });
  assert.equal(home.headers.get("location"), "/management.html");
  const panelHtml = "<html><head><title>Console</title></head><body>tested edge panel</body></html>";
  await (await publicWorker.getR2Bucket("STATE")).put("dashboard/management.html", panelHtml);
  const dashboard = await publicWorker.dispatchFetch("https://gateway.example/management.html", { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.equal(dashboardHtml, panelHtml, "The native panel is the complete document, not an iframe wrapper");
  assert.doesNotMatch(dashboardHtml, /Start controls|<iframe|controls_remaining_ms|sub2api|CLIProxyAPI|CPAMC|\bCPA\b|github\.com/);
  const panel = await publicWorker.dispatchFetch("https://gateway.example/provider-panel.html", { headers: { cookie } });
  assert.equal(panel.status, 200);
  assert.equal(await panel.text(), panelHtml);
  const blocked = await publicWorker.dispatchFetch("https://gateway.example/private-file");
  assert.equal(blocked.status, 404);
  const privateActivity = await publicWorker.dispatchFetch("https://gateway.example/__sub2api/activity", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "begin", id: "a".repeat(32) }),
  });
  assert.equal(privateActivity.status, 404, "Internal activity protocol must never be publicly routed");
  assert.deepEqual(await publicWorker.listDurableObjectIds("CPA"), [], "Local routes must not activate the container Durable Object");
  console.log("PASS: actual Worker bundle loads Wasm; direct neutral panel, login, liveness, session and blocked routes avoid the container object.");
  const stopped = await publicWorker.dispatchFetch("https://gateway.example/runtime/status", { headers: { cookie } });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { running: false, controls_remaining_ms: 0 });
  const refused = await publicWorker.dispatchFetch("https://gateway.example/v1/models", { headers: { authorization: 'Bearer invalid' } });
  assert.equal(refused.status, 401);
} finally {
  await publicWorker.dispose();
}

// Exercise the actual WorkerEntrypoint -> existing Cpa namespace RPC wiring. This fixture
// has no container binding, so a valid private notification must be refused without startup.
const rpcHarness = resolve(temporary, "rpc-harness.ts");
await writeFile(rpcHarness, `
export { Cpa, R2Bridge } from ${JSON.stringify(process.argv[2] ? artifact : resolve(root, "src/cpa.ts"))};
export default { async fetch(request, env, ctx) {
  const activityRequest = () => new Request('http://r2.internal/__sub2api/activity', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({action:'begin', id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
  });
  const bridgeFor = (containerId) => ctx.exports.R2Bridge({ props: { containerId } });
  if (new URL(request.url).pathname === '/activity') {
    const outcomes = await Promise.all(['owner-a', 'owner-b'].map(async name => {
      const containerId = env.CPA.idFromName(name).toString();
      const response = await bridgeFor(containerId).fetch(activityRequest());
      return { containerId, status: response.status };
    }));
    return Response.json(outcomes);
  }
  if (new URL(request.url).pathname === '/bad-props') {
    const response = await bridgeFor('not-an-id').fetch(activityRequest());
    return Response.json({ status: response.status });
  }
  if (new URL(request.url).pathname === '/conditional-write') {
    const bridge = bridgeFor(env.CPA.idFromName('r2-write-test').toString());
    const key = 'http://r2.internal/state/runtime-conditional-write-test';
    const seed = await bridge.fetch(new Request(key, { method: 'PUT', headers: {'if-none-match':'*'}, body:'seed' }));
    const etag = seed.headers.get('etag');
    const results = await Promise.all(['writer-a', 'writer-b'].map(body => bridge.fetch(new Request(key, {
      method:'PUT', headers:{'if-match':etag}, body
    }))));
    const final = await bridge.fetch(new Request(key));
    return Response.json({ seed: seed.status, etag, writers: results.map(response => response.status), final: await final.text() });
  }
  return new Response(null, {status:404});
} };
`);
const rpcOutput = resolve(temporary, "rpc/index.js");
await bundle(rpcHarness, rpcOutput);
const rpcWorker = new Miniflare(convertV4MiniflareOptions({
  ...await options(rpcOutput),
  durableObjects: { CPA: { className: "Cpa", useSQLite: true } },
  r2Buckets: ["STATE"],
  ratelimits: { LOGIN_LIMIT: { namespace_id: "1001", simple: { limit: 20, period: 60 } } },
}));
try {
  const routed = await rpcWorker.dispatchFetch("https://internal-test.example/activity");
  const outcomes = await routed.json();
  assert.equal(outcomes.length, 2);
  assert.equal(new Set(outcomes.map(outcome => outcome.containerId)).size, 2);
  assert.deepEqual(outcomes.map(outcome => outcome.status), [409, 409], "Each owner-local RPC refuses stopped-container activity");
  assert.equal((await rpcWorker.listDurableObjectIds("CPA")).length, 2, "Activity callbacks address each requested owner DO");
  const badProps = await rpcWorker.dispatchFetch("https://internal-test.example/bad-props");
  assert.deepEqual(await badProps.json(), { status: 404 }, "Missing or malformed owner identity fails closed");
  assert.equal((await rpcWorker.listDurableObjectIds("CPA")).length, 2, "Invalid owner identity must not create or route to a DO");
  const conditional = await rpcWorker.dispatchFetch("https://internal-test.example/conditional-write");
  const writeResult = await conditional.json();
  assert.equal(writeResult.seed, 200, "Create-only put is supported by the actual workerd R2 binding");
  assert.match(writeResult.etag, /^".+"$/);
  assert.deepEqual(writeResult.writers.sort(), [200, 412], "R2 atomically rejects one competing stale If-Match writer");
  assert.ok(["writer-a", "writer-b"].includes(writeResult.final));
  console.log("PASS: real workerd RPC routes activity to two explicit Cpa owner IDs; invalid owner IDs fail closed; concurrent conditional R2 writes yield one success and one 412.");
} finally {
  await rpcWorker.dispose();
}

if (process.argv[2]) {
  console.log("PASS: prepared-bundle checks use only the received Worker/Wasm artifacts; source SSE/WebSocket checks remain a required GitHub CI gate.");
} else {
  // A controlled provider exercises Web APIs that Node's Response does not implement (status 101).
  // It replaces only the external provider, not the Rust gateway or key guard.
  const harness = resolve(temporary, "provider-harness.ts");
  await writeFile(harness, `
  import { handle } from ${JSON.stringify(resolve(root, "src/gateway.ts"))};
  import { KeyGuard } from ${JSON.stringify(resolve(root, "src/key-guard.ts"))};
  import { publicProviderResponse } from ${JSON.stringify(resolve(root, "src/branding.ts"))};
  const now = () => Math.floor(Date.now()/1000);
  const key = ${JSON.stringify(key)};
  const store = { get: async (path) => path === 'config/config.yaml' ? { text: async () => JSON.stringify({'config-version':8, access:{'api-keys':[key]}}) } : null };
  const config = { dashboardPassword: ${JSON.stringify(password)}, nowSeconds: now, apiAccess: new KeyGuard(store, () => false), loginLimiter: { limit: async () => ({success: true}) } };
  async function provider(request) {
    if (request.headers.has('cookie')) return new Response('cookie leaked', { status: 500 });
    if (new URL(request.url).pathname === '/healthz') return new Response('provider ready');
    if (request.headers.get('x-api-key') !== key) return new Response('unauthorized', {status:401});
    if (request.headers.get('upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener('message', event => server.send(event.data));
      server.addEventListener('close', event => server.close(event.code, event.reason));
      return new Response(null, {status:101, webSocket:client, headers:{'X-CPA-VERSION':'v8.0.67','access-control-expose-headers':'X-CPA-VERSION, X-Request-ID'}});
    }
    if (request.headers.get('x-test-upload') === 'yes') return new Response(String((await request.arrayBuffer()).byteLength));
    let timer;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\\n\\n'));
        timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('data: last\\n\\n')); controller.close(); }, 1200);
      },
      cancel() { clearTimeout(timer); },
    });
    return new Response(stream, {headers:{'content-type':'text/event-stream','X-CPA-VERSION':'v8.0.67','x-cpa-support-plugin':'true','access-control-expose-headers':'Content-Type, X-CPA-VERSION, X-CPA-SUPPORT-PLUGIN'}});
  }
  export default { fetch(request) { return handle(request, config, async request => publicProviderResponse(await provider(request))); } };
  `);
  const harnessOutput = resolve(temporary, "harness/index.js");
  await bundle(harness, harnessOutput);
  const gateway = new Miniflare(convertV4MiniflareOptions(await options(harnessOutput)));
  try {
    const denied = await gateway.dispatchFetch("https://gateway.example/v1/messages", { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);
    const response = await gateway.dispatchFetch("https://gateway.example/v1/messages", {
      method: "POST", headers: { "x-api-key": key, cookie: "private-cookie=value" }, body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-cpa-version"), null);
    assert.equal(response.headers.get("x-sub2api-engine-version"), null);
    assert.equal(response.headers.get("x-engine-version"), "v8.0.67");
    assert.equal(response.headers.get("x-engine-support-plugin"), "true");
    assert.equal(response.headers.get("access-control-expose-headers"), "Content-Type, x-engine-version, x-engine-support-plugin");
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString(), "data: first\n\n");
    const last = await reader.read();
    assert.equal(Buffer.from(last.value).toString(), "data: last\n\n");
    assert.equal((await reader.read()).done, true);
    const upload = await gateway.dispatchFetch("https://gateway.example/v1/messages", {
      method: "POST", headers: { "x-api-key": key, "x-test-upload": "yes" }, body: Buffer.alloc(2 * 1024 * 1024, 65),
    });
    assert.equal(await upload.text(), "2097152");
    const ready = await gateway.dispatchFetch("https://gateway.example/readyz");
    assert.equal(await ready.text(), "provider ready");
    const socketResponse = await gateway.dispatchFetch("https://gateway.example/v1/responses", {
      headers: { upgrade: "websocket", "x-api-key": key, cookie: "private-cookie=value" },
    });
    assert.equal(socketResponse.status, 101);
    assert.equal(socketResponse.headers.get("x-cpa-version"), null);
    assert.equal(socketResponse.headers.get("x-sub2api-engine-version"), null);
    assert.equal(socketResponse.headers.get("x-engine-version"), "v8.0.67");
    assert.equal(socketResponse.headers.get("access-control-expose-headers"), "x-engine-version, X-Request-ID");
    const socket = socketResponse.webSocket;
    assert.ok(socket, "WebSocket upgrade object survives the Wasm boundary");
    socket.accept();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
    const message = new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket echo timed out")), 5000);
      socket.addEventListener("message", event => { clearTimeout(timer); resolveMessage(event.data); }, { once: true });
    });
    socket.send("still active");
    assert.equal(await message, "still active");
    socket.close(1000, "verified");
    console.log("PASS: Rust gateway preserves authorization, 2 MiB upload, SSE, provider readiness and native WebSocket upgrades with neutral engine headers.");
    console.log("Container stop/start and provider accounts still require the Docker/live checks; this smoke test does not simulate those guarantees.");
  } finally {
    await gateway.dispose();
  }
}
