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
  assert.match(await form.text(), /name="password"/);
  const login = await publicWorker.dispatchFetch("https://gateway.example/login", {
    method: "POST", body: new URLSearchParams({ password }), redirect: "manual",
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Rust login returns a session cookie");
  const home = await publicWorker.dispatchFetch("https://gateway.example/", { headers: { cookie }, redirect: "manual" });
  assert.equal(home.headers.get("location"), "/management.html");
  const blocked = await publicWorker.dispatchFetch("https://gateway.example/private-file");
  assert.equal(blocked.status, 404);
  const privateActivity = await publicWorker.dispatchFetch("https://gateway.example/__sub2api/activity", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "begin", id: "a".repeat(32) }),
  });
  assert.equal(privateActivity.status, 404, "Internal activity protocol must never be publicly routed");
  assert.deepEqual(await publicWorker.listDurableObjectIds("CPA"), [], "Local routes must not activate the container Durable Object");
  console.log("PASS: actual Worker bundle loads Wasm; liveness/login/session/blocked routes avoid the container object.");
} finally {
  await publicWorker.dispose();
}

// Exercise the actual WorkerEntrypoint -> existing Cpa namespace RPC wiring. This fixture
// has no container binding, so a valid private notification must be refused without startup.
const rpcHarness = resolve(temporary, "rpc-harness.ts");
await writeFile(rpcHarness, `
export { Cpa, R2Bridge } from ${JSON.stringify(resolve(root, "src/cpa.ts"))};
export default { fetch(request, env, ctx) {
  return ctx.exports.R2Bridge.fetch(new Request('http://r2.internal/__sub2api/activity', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({action:'begin', id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
  }));
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
  const refused = await rpcWorker.dispatchFetch("https://internal-test.example/notify");
  assert.equal(refused.status, 409, "Real private RPC refuses work when no container is running");
  assert.equal((await rpcWorker.listDurableObjectIds("CPA")).length, 1);
  console.log("PASS: real workerd entrypoint/RPC wiring reaches the preserved Cpa namespace and refuses stopped-container activity.");
} finally {
  await rpcWorker.dispose();
}

// A controlled provider exercises Web APIs that Node's Response does not implement (status 101).
// It replaces only the external provider, not the Rust gateway or key guard.
const harness = resolve(temporary, "provider-harness.ts");
await writeFile(harness, `
import { handle } from ${JSON.stringify(resolve(root, "src/gateway.ts"))};
import { KeyGuard } from ${JSON.stringify(resolve(root, "src/key-guard.ts"))};
const now = () => Math.floor(Date.now()/1000);
const config = { dashboardPassword: ${JSON.stringify(password)}, nowSeconds: now, keyGuard: new KeyGuard(now), loginLimiter: { limit: async () => ({success: true}) } };
const key = ${JSON.stringify(key)};
async function provider(request) {
  if (request.headers.has('cookie')) return new Response('cookie leaked', { status: 500 });
  if (new URL(request.url).pathname === '/healthz') return new Response('provider ready');
  if (request.headers.get('x-api-key') !== key) return new Response('unauthorized', {status:401});
  if (request.headers.get('upgrade') === 'websocket') {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener('message', event => server.send(event.data));
    server.addEventListener('close', event => server.close(event.code, event.reason));
    return new Response(null, {status:101, webSocket:client});
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
  return new Response(stream, {headers:{'content-type':'text/event-stream'}});
}
export default { fetch(request) { return handle(request, config, provider); } };
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
  console.log("PASS: Rust gateway preserves authorization, 2 MiB upload, SSE, provider readiness and native WebSocket upgrades.");
  console.log("Container stop/start and provider accounts still require the Docker/live checks; this smoke test does not simulate those guarantees.");
} finally {
  await gateway.dispose();
}
