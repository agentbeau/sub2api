// Compares the existing Rust/Wasm path classifier with Hono and itty-router.
// This isolates router dispatch; it does not compare complete auth/provider stacks.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { initSync, classify } from "../gateway-rs/pkg/gateway_core.js";
import { Hono } from "hono";
import { IttyRouter } from "itty-router";
import { fetcher } from "itty-fetcher";

const wasmBytes = await readFile(new URL("../gateway-rs/pkg/gateway_core_bg.wasm", import.meta.url));
const wasmCompileStart = performance.now();
initSync({ module: new WebAssembly.Module(wasmBytes) });
const wasmInitMs = performance.now() - wasmCompileStart;

const corpus = [
  ["/", "home"], ["/login", "login"], ["/logout", "logout"], ["/healthz", "health"],
  ["/readyz", "ready"], ["/callback", "oauth-callback"], ["/auth/callback", "oauth-callback"],
  ["/oauth-callback", "oauth-callback"], ["/management.html", "dashboard"],
  ["/provider-panel.html", "dashboard"], ["/runtime/status", "dashboard"],
  ["/v0/management/config", "dashboard"], ["/v8/management/oauth/auth-url", "dashboard"],
  ["/v1/chat/completions", "api"], ["/v1beta/models/gemini:generateContent", "api"],
  ["/v1", "blocked"], ["/v1beta", "blocked"], ["/v0/management", "blocked"],
  ["/v1evil/messages", "blocked"], ["/management.html/extra", "blocked"],
  ["/v1/%2e%2e/v0/management/config", "blocked"], ["/v1/..%2Fv0/management/config", "blocked"],
  ["/v1/%5Cmessages", "blocked"], ["/v1/\\messages", "blocked"], ["/v1//messages", "blocked"],
  ["//login", "blocked"], ["/robots.txt", "blocked"],
];

// Mirror the Rust classifier's dangerous raw-path guard. URL parsing can
// normalize encoded dot segments before the Worker receives a Request.
const rawPathBlocked = path => path.includes("\\") || path.includes("//") || /%(?:2f|2e|5c)/i.test(path);
const requestPathBlocked = path => rawPathBlocked(path)
  || ["/v1", "/v1beta", "/v0/management", "/v8/management"].includes(path);
const reply = label => new Response(label, { status: 200 });
const route = (add, label, paths) => { for (const path of paths) add(path, () => reply(label)); };
const fixed = {
  home: ["/"], login: ["/login"], logout: ["/logout"], health: ["/healthz"], ready: ["/readyz"],
  "oauth-callback": ["/callback", "/auth/callback", "/oauth-callback"],
  dashboard: ["/management.html", "/provider-panel.html", "/runtime/status", "/runtime/start", "/runtime/stop"],
};

const setupStart = performance.now();
const hono = new Hono();
for (const [label, paths] of Object.entries(fixed)) route((path, handler) => hono.all(path, handler), label, paths);
for (const prefix of ["/v1/*", "/v1beta/*"]) hono.all(prefix, () => reply("api"));
for (const prefix of ["/v0/management/*", "/v8/management/*"]) hono.all(prefix, () => reply("dashboard"));
hono.notFound(() => reply("blocked"));

const itty = IttyRouter();
for (const [label, paths] of Object.entries(fixed)) route((path, handler) => itty.all(path, handler), label, paths);
for (const prefix of ["/v1/*", "/v1beta/*"]) itty.all(prefix, () => reply("api"));
for (const prefix of ["/v0/management/*", "/v8/management/*"]) itty.all(prefix, () => reply("dashboard"));
itty.all("*", () => reply("blocked"));
const routerSetupMs = performance.now() - setupStart;

const makeRequest = path => new Request(`https://gateway.example${path}`);
const implementations = {
  "Rust/Wasm": async request => reply(classify(new URL(request.url).pathname),),
  Hono: async request => requestPathBlocked(new URL(request.url).pathname) ? reply("blocked") : hono.fetch(request),
  "itty-router": async request => requestPathBlocked(new URL(request.url).pathname) ? reply("blocked") : itty.fetch(request),
};

// Check both direct raw-path policy and framework output after Request URL parsing.
for (const [path, expected] of corpus) {
  if (classify(path) !== expected) throw new Error(`Rust raw path policy mismatch for ${path}`);
  const request = makeRequest(path);
  const parsedExpected = classify(new URL(request.url).pathname);
  for (const [name, invoke] of Object.entries(implementations)) {
    const actual = await (await invoke(request)).text();
    if (actual !== parsedExpected) throw new Error(`${name} route mismatch for ${path}: expected ${parsedExpected}, got ${actual}`);
  }
}

// Exercise native Fetch pass-through separately from route timing.
let wasCancelled;
let upstreamResponse;
const seenRequests = [];
const forward = async request => {
  seenRequests.push(request);
  upstreamResponse = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("event: ping\\ndata: ok\\n\\n")); },
    cancel() { wasCancelled = true; },
  }), { headers: { "content-type": "text/event-stream", "x-provider": "synthetic" } });
  return upstreamResponse;
};
const honoStream = new Hono();
honoStream.all("/v1/*", context => forward(context.req.raw));
const ittyStream = IttyRouter();
ittyStream.all("/v1/*", request => forward(request));
for (const [name, invoke] of [["Hono", request => honoStream.fetch(request)], ["itty-router", request => ittyStream.fetch(request)]]) {
  wasCancelled = false;
  const controller = new AbortController();
  const incoming = new Request("https://gateway.example/v1/messages", {
    method: "POST", headers: { authorization: "Bearer synthetic", cookie: "dashboard-session" },
    body: new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("request")); } }),
    duplex: "half", signal: controller.signal,
  });
  const response = await invoke(incoming);
  if (response !== upstreamResponse || response.headers.get("x-provider") !== "synthetic") throw new Error(`${name} did not preserve the native Response`);
  const forwarded = seenRequests.at(-1);
  if (forwarded.bodyUsed || forwarded.headers.get("authorization") !== "Bearer synthetic" || forwarded.headers.get("cookie") !== "dashboard-session") {
    throw new Error(`${name} changed request-body state or forwarded headers`);
  }
  controller.abort();
  if (!forwarded.signal.aborted) throw new Error(`${name} did not propagate request cancellation`);
  await response.body.cancel();
  if (!wasCancelled) throw new Error(`${name} did not propagate response-stream cancellation`);
}

// itty-fetcher must use parse:false for upstream streaming. Confirm it keeps a
// non-2xx raw Response readable and exposes native headers and abort signals.
let fetchRequest;
let fetchStreamCancelled = false;
const rawErrorResponse = new Response(new ReadableStream({ cancel() { fetchStreamCancelled = true; } }), {
  status: 502, headers: { "content-type": "text/event-stream", "x-upstream": "synthetic" },
});
const fetcherApi = fetcher({ parse: false, fetch: async request => { fetchRequest = request; return rawErrorResponse; } });
const fetchController = new AbortController();
let fetcherError;
try {
  await fetcherApi.get("https://upstream.example/stream", {
    signal: fetchController.signal, headers: { authorization: "Bearer synthetic" },
  });
} catch (error) { fetcherError = error; }
if (!fetcherError || fetcherError.response !== rawErrorResponse || rawErrorResponse.bodyUsed
  || rawErrorResponse.headers.get("x-upstream") !== "synthetic") {
  throw new Error("itty-fetcher raw mode did not preserve the non-2xx streaming Response");
}
if (fetchRequest.headers.get("authorization") !== "Bearer synthetic") throw new Error("itty-fetcher changed request headers");
fetchController.abort();
if (!fetchRequest.signal.aborted) throw new Error("itty-fetcher did not propagate request cancellation");
await fetcherError.response.body.cancel();
if (!fetchStreamCancelled) throw new Error("itty-fetcher did not propagate response-stream cancellation");

const paths = ["/v1/chat/completions", "/v0/management/config", "/management.html", "/v1/%2e%2e/v0/management/config"];
const names = Object.keys(implementations);
const rounds = 5;
const iterations = 3000;
const warmup = 300;
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const measurements = {};
for (const path of paths) {
  const request = makeRequest(path);
  const timings = Object.fromEntries(names.map(name => [name, []]));
  for (const name of names) for (let i = 0; i < warmup; i++) await (await implementations[name](request)).text();
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...names].reverse() : names;
    for (const name of order) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) await (await implementations[name](request)).text();
      timings[name].push((performance.now() - start) * 1000 / iterations);
    }
  }
  measurements[path] = Object.fromEntries(names.map(name => [name, {
    medianUs: median(timings[name]), roundMediansUs: timings[name],
  }]));
}

// Run the same routing corpus in workerd. Each cold sample starts a fresh
// Miniflare instance; this is a local cold-isolate measurement, not Cloudflare's
// distributed edge or a container cold start.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = resolve(root, ".wrangler/framework-benchmark");
await mkdir(temporary, { recursive: true });
const dangerousCheck = `const blocked = p => p.includes('\\\\') || p.includes('//') || /%(?:2f|2e|5c)/i.test(p) || ['/v1','/v1beta','/v0/management','/v8/management'].includes(p);`;
const fixedRoutes = Object.entries(fixed).flatMap(([label, paths]) => paths.map(path => `router.all(${JSON.stringify(path)}, () => new Response(${JSON.stringify(label)}));`)).join("\n");
const workerSources = {
  rust: `import { classify } from ${JSON.stringify(resolve(root, "src/wasm.ts"))};\nexport default { fetch(request) { return new Response(classify(new URL(request.url).pathname)); } };`,
  hono: `import { Hono } from "hono";\nconst app = new Hono();\n${dangerousCheck}\napp.use('*', async (c,next) => { if (blocked(new URL(c.req.raw.url).pathname)) return new Response('blocked'); await next(); });\n${fixedRoutes.replaceAll("router.", "app.")}\nfor (const p of ['/v1/*','/v1beta/*']) app.all(p, () => new Response('api'));\nfor (const p of ['/v0/management/*','/v8/management/*']) app.all(p, () => new Response('dashboard'));\napp.notFound(() => new Response('blocked'));\nexport default { fetch: app.fetch };`,
  itty: `import { IttyRouter } from "itty-router";\nconst router = IttyRouter();\n${dangerousCheck}\n${fixedRoutes}\nfor (const p of ['/v1/*','/v1beta/*']) router.all(p, () => new Response('api'));\nfor (const p of ['/v0/management/*','/v8/management/*']) router.all(p, () => new Response('dashboard'));\nrouter.all('*', () => new Response('blocked'));\nexport default { fetch(request) { if (blocked(new URL(request.url).pathname)) return new Response('blocked'); return router.fetch(request); } };`,
};
const workerBundles = {};
for (const [name, source] of Object.entries(workerSources)) {
  const dir = resolve(temporary, name);
  await mkdir(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts");
  const output = resolve(dir, "index.js");
  await writeFile(entry, source);
  await build({ entryPoints: [entry], outfile: output, bundle: true, format: "esm", platform: "neutral", target: "esnext", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*"], loader: { ".wasm": "copy" }, logLevel: "warning" });
  workerBundles[name] = output;
}
const workerOptions = async bundlePath => ({
  modules: [
    { type: "ESModule", path: bundlePath },
    ...(await readdir(resolve(bundlePath, ".."), { recursive: true })).filter(path => path.endsWith(".wasm")).map(path => ({ type: "CompiledWasm", path: resolve(resolve(bundlePath, ".."), path) })),
  ],
  modulesRoot: resolve(bundlePath, ".."), compatibilityDate: "2026-10-01", cf: false,
});
const workerd = {};
const workerdWarmPaths = ["/v1/chat/completions", "/v0/management/config", "/management.html", "/v1/%2e%2e/v0/management/config"];
for (const [name, bundlePath] of Object.entries(workerBundles)) {
  const coldMs = [];
  for (let sample = 0; sample < 3; sample++) {
    const start = performance.now();
    const fresh = new Miniflare(convertV4MiniflareOptions(await workerOptions(bundlePath)));
    const response = await fresh.dispatchFetch("https://gateway.example/v1/chat/completions");
    const label = await response.text();
    if (label !== "api") throw new Error(`${name} workerd cold route mismatch: ${label}`);
    coldMs.push(performance.now() - start);
    await fresh.dispose();
  }
  const fresh = new Miniflare(convertV4MiniflareOptions(await workerOptions(bundlePath)));
  const warmUs = {};
  try {
    const first = await fresh.dispatchFetch("https://gateway.example/v1/chat/completions");
    await first.text();
    for (const path of workerdWarmPaths) {
      const expected = classify(new URL(`https://gateway.example${path}`).pathname);
      const url = `https://gateway.example${path}`;
      for (let i = 0; i < 100; i++) {
        const response = await fresh.dispatchFetch(url);
        if (await response.text() !== expected) throw new Error(`${name} workerd warm route mismatch for ${path}`);
      }
      const timings = [];
      for (let round = 0; round < 3; round++) {
        const start = performance.now();
        for (let i = 0; i < 500; i++) {
          const response = await fresh.dispatchFetch(url);
          if (await response.text() !== expected) throw new Error(`${name} workerd response drift for ${path}`);
        }
        timings.push((performance.now() - start) * 1000 / 500);
      }
      warmUs[path] = { medianUs: median(timings), roundMediansUs: timings };
    }
  } finally {
    await fresh.dispose();
  }
  workerd[name] = { coldFreshInstanceFirstFetchMs: median(coldMs), coldSamplesMs: coldMs, warmRouteMedianUs: warmUs };
}
await rm(temporary, { recursive: true, force: true });

console.log(JSON.stringify({
  measuredAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  packageVersions: { hono: "4.13.19", ittyRouter: "5.0.24", ittyFetcher: "1.0.10" },
  setup: { wasmInitMs, routerRegistrationMs: routerSetupMs },
  correctness: { rawPolicyPaths: corpus.length, parsedRequestPaths: corpus.length, passed: true },
  compatibility: { rawSseStreamPassThrough: true, requestSignalAndHeaders: true, responseCancellation: true, ittyFetcherRaw502: true },
  methodology: `Node measurements reuse a prebuilt Request; each adapter constructs and reads an equivalent short Response; ${warmup} warm-ups, ${rounds} rounds × ${iterations} requests per route, alternating order. The workerd cold measure includes constructing a fresh local Miniflare Worker and its first fetch (three fresh instances); warm uses a persistent Miniflare Worker after warm-up. Neither is a Cloudflare edge/cold-container measurement. This measures routing only, not full auth/provider stacks, billed CPU, network, or provider inference.`,
  warmRouteMedianUs: measurements,
  workerd,
}, null, 2));
