// Local CPU overhead comparison. This does not measure Cloudflare/provider network latency.
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: node scripts/benchmark-gateway.mjs /path/to/original-checkout [report.json]");
const output = resolve(root, ".wrangler/benchmark");
await mkdir(output, { recursive: true });
async function compile(entry, name) {
  const outfile = resolve(output, `${name}.mjs`);
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning",
    plugins: [{ name: "wasm-module", setup(builder) {
      builder.onLoad({ filter: /\.wasm$/ }, ({ path }) => ({
        contents: `import { readFileSync } from 'node:fs'; export default new WebAssembly.Module(readFileSync(${JSON.stringify(path)}));`, loader: "js",
      }));
    } }],
  });
  const start = performance.now();
  const module = await import(pathToFileURL(outfile).href);
  return { module, importMs: performance.now() - start };
}
const old = await compile(resolve(baseline, "src/gateway.ts"), "original");
const current = await compile(resolve(root, "src/gateway.ts"), "rust");
const session = await compile(resolve(baseline, "worker/src/session.ts"), "session");
const password = "benchmark-password-0123456789abcdef";
const now = 1_800_000_000;
const token = await session.module.issueSession(password, now);
const config = {
  dashboardPassword: password, nowSeconds: () => now,
  keyGuard: { state: async () => "required", forget() {} },
  loginLimiter: { limit: async () => ({ success: true }) },
};
const currentConfig = { dashboardPassword: password, nowSeconds: () => now,
  apiAccess: { authorize: async () => "allowed", invalidate() {} }, loginLimiter: config.loginLimiter };
const forward = async () => new Response(null, { status: 204 });
const cases = {
  blocked_path: () => new Request("https://gateway.example/not-a-route"),
  authenticated_dashboard: () => new Request("https://gateway.example/v8/management/config", { headers: { cookie: `__Host-gateway_session=${token}` } }),
  api_forward_cached_guard: () => new Request("https://gateway.example/v1/messages", { method: "POST", headers: { "x-api-key": "benchmark-key" }, body: "{}" }),
  successful_login: () => new Request("https://gateway.example/login", { method: "POST", body: new URLSearchParams({ password }) }),
};
const iterations = 2000;
const rounds = 5;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = {};
for (const [name, request] of Object.entries(cases)) {
  const timings = { original: [], rust: [] };
  for (const implementation of [old, current]) {
    for (let i = 0; i < 300; i++) await implementation.module.handle(request(), implementation === old ? config : currentConfig, forward);
  }
  for (let round = 0; round < rounds; round++) {
    // Alternate order to reduce warmup and thermal bias.
    for (const [label, implementation] of round % 2 ? [["rust", current], ["original", old]] : [["original", old], ["rust", current]]) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) await implementation.module.handle(request(), implementation === old ? config : currentConfig, forward);
      timings[label].push((performance.now() - start) * 1000 / iterations);
    }
  }
  const oldUs = median(timings.original);
  const rustUs = median(timings.rust);
  results[name] = { originalMedianUs: oldUs, rustMedianUs: rustUs, ratioOriginalOverRust: oldUs / rustUs, samplesUs: timings };
}
const wasmBytes = (await readFile(resolve(root, "gateway-rs/pkg/gateway_core_bg.wasm"))).byteLength;
const report = {
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, baselineCommit: "d7da1f8794830b5e42d921b6e526e5f5ab3a1136",
  iterationsPerRound: iterations, rounds, wasmBytes,
  oneSampleModuleImportMs: { original: old.importMs, rust: current.importMs },
  scope: "Local Node/V8 warm gateway CPU overhead including Request/Response construction; mocked external provider and admission. Excludes R2 configuration reads, production network, cold container, end-to-end model latency, and Cloudflare billed CPU.",
  results,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (process.argv[3]) await writeFile(resolve(process.argv[3]), text);
console.log(text);
