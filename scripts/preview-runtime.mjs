// Verify the actual bundled preview refuses all routes without platform identity.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const artifact = resolve(process.argv[2]);
const base = dirname(artifact);
const worker = new Miniflare(convertV4MiniflareOptions({
  modules: [{ type: "ESModule", path: artifact }, ...(await readdir(base, { recursive: true })).filter(path => path.endsWith(".wasm")).map(path => ({ type: "CompiledWasm", path: resolve(base, path) }))],
  modulesRoot: base, compatibilityDate: "2026-10-01", cf: false,
  bindings: { PREVIEW_ACCESS_AUD: "b".repeat(64), ACCESS_AUD: "b".repeat(64), DASHBOARD_AUTH: "cloudflare" },
  durableObjects: { CPA: { className: "Cpa", useSQLite: true } }, r2Buckets: ["STATE"],
  ratelimits: { LOGIN_LIMIT: { namespace_id: "1101", simple: { limit: 5, period: 60 } } },
}));
try {
  for (const path of ["/", "/healthz", "/readyz", "/v1/models", "/v1/chat/completions", "/management.html", "/v0/management/config"]) {
    const result = await worker.dispatchFetch(`https://preview.example${path}`, { headers: { "cf-access-jwt-assertion": "forged", "cf-access-authenticated-user-email": "owner@example.com" } });
    assert.equal(result.status, 403, path);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  console.log("Actual preview bundle denied all unauthenticated/forged-identity probes.");
} finally { await worker.dispose(); }
