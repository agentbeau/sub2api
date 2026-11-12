import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { it } from "vitest";

it("carries simulated native Access context through real workerd/Rust/RPC without inheriting it on ordinary fetch", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = resolve(root, ".wrangler/access-runtime-test");
  await mkdir(temporary, { recursive: true });
  const entry = resolve(temporary, "harness.ts");
  const output = resolve(temporary, "index.js");
  // Only this local harness simulates platform identity. No query/header based
  // authentication exists in the production entrypoint or deployment bundle.
  await writeFile(entry, `
    import worker from ${JSON.stringify(resolve(root, "src/index.ts"))};
    export { Cpa, R2Bridge } from ${JSON.stringify(resolve(root, "src/cpa.ts"))};
    export default { fetch(request, env, ctx) {
      const mode = new URL(request.url).searchParams.get('test_context');
      const context = mode === 'valid' ? { access: { aud: 'runtime-access-app' } }
        : mode === 'wrong' ? { access: { aud: 'another-app' } } : ctx;
      return worker.fetch(request, env, context);
    } };
  `);
  await build({ entryPoints: [entry], outfile: output, bundle: true, format: "esm", platform: "neutral", target: "esnext",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*"], loader: { ".wasm": "copy" }, logLevel: "warning" });
  const worker = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: "ESModule", path: output }, ...(await readdir(temporary)).filter(path => path.endsWith(".wasm")).map(path => ({ type: "CompiledWasm" as const, path: resolve(temporary, path) }))],
    modulesRoot: dirname(output), compatibilityDate: "2026-10-01", cf: false,
    bindings: { DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: "runtime-access-app", DASHBOARD_PASSWORD: "unused-old-dashboard-password-0123456789", CONTAINER_IDLE_TIMEOUT_MS: "1000" },
    durableObjects: { CPA: { className: "Cpa", useSQLite: true } }, r2Buckets: ["STATE"],
    ratelimits: { LOGIN_LIMIT: { namespace_id: "1001", simple: { limit: 20, period: 60 } } },
  }));
  try {
    const bucket = await worker.getR2Bucket("STATE");
    await bucket.put("dashboard/management.html", "<title>Console</title><main>native console</main>");
    for (const path of ["/login", "/management.html", "/runtime/status", "/v8/management/config"]) {
      const denied = await worker.dispatchFetch(`https://gateway.example${path}`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "forged", cookie: "CF_Authorization=forged" } });
      assert.equal(denied.status, 401, path);
    }
    assert.deepEqual(await worker.listDurableObjectIds("CPA"), []);
    const login = await worker.dispatchFetch("https://gateway.example/login?test_context=valid", { redirect: "manual" });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/management.html");
    assert.equal(login.headers.get("set-cookie"), null);
    const panel = await worker.dispatchFetch("https://gateway.example/management.html?test_context=valid");
    assert.equal(panel.status, 200);
    assert.equal(await panel.text(), "<title>Console</title><main>native console</main>");
    assert.deepEqual(await worker.listDurableObjectIds("CPA"), []);
    const wrong = await worker.dispatchFetch("https://gateway.example/management.html?test_context=wrong");
    assert.equal(wrong.status, 401);
    const status = await worker.dispatchFetch("https://gateway.example/runtime/status?test_context=valid");
    assert.equal(status.status, 200, "Verified context crosses the private RPC into the actual object");
    assert.deepEqual(await status.json(), { running: false, controls_remaining_ms: 0 });
    const ns = await worker.getDurableObjectNamespace("CPA");
    const stub = ns.get(ns.idFromName("cf-singleton-container"));
    const direct = await stub.fetch("https://gateway.example/runtime/status", { headers: { "cf-access-jwt-assertion": "forged", cookie: "CF_Authorization=forged" } });
    assert.equal(direct.status, 401, "A later ordinary fetch must not inherit an earlier RPC identity");
    const api = await worker.dispatchFetch("https://gateway.example/v1/models");
    assert.equal(api.status, 401);
    assert.equal(api.headers.get("location"), null, "API authentication never becomes a browser login redirect");
    const health = await worker.dispatchFetch("https://gateway.example/healthz");
    assert.equal(health.status, 200);
    const logout = await worker.dispatchFetch("https://gateway.example/logout?test_context=valid", { redirect: "manual" });
    assert.equal(logout.headers.get("location"), "/cdn-cgi/access/logout");
  } finally {
    await worker.dispose();
  }
}, 30_000);
