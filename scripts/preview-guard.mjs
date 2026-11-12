// Deployment gate, deliberately separate from production's main-only pipeline.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function validatePreview(config, branch, { ready = true } = {}) {
  assert.equal(branch, "dagul/isolated-worker-preview", "Only the isolated preview branch is allowed");
  assert.equal(config.name, "sub2api-preview-isolated");
  assert.equal(config.main, "src/preview.ts");
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.routes, []);
  for (const key of ["services", "secrets_store_secrets", "env", "previews"])
    assert.equal(config[key], undefined, `No top-level ${key} allowed`);
  const p = config;
  assert.deepEqual(Object.keys(p).sort(), ["$schema", "compatibility_date", "containers", "durable_objects", "main", "migrations", "name", "r2_buckets", "ratelimits", "routes", "vars", "workers_dev"]);
  assert.deepEqual(p.r2_buckets, [{ binding: "STATE", bucket_name: "sub2api-preview-isolated" }]);
  assert.deepEqual(p.durable_objects, { bindings: [{ name: "CPA", class_name: "Cpa" }] });
  assert.deepEqual(p.containers, [{ class_name: "Cpa", image: "./container/Dockerfile", image_build_context: "./container", instance_type: "basic", max_instances: 1 }]);
  assert.deepEqual(p.ratelimits, [{ name: "LOGIN_LIMIT", namespace_id: "1101", simple: { limit: 5, period: 60 } }]);
  assert.deepEqual(Object.keys(p.vars).sort(), ["ACCESS_AUD", "CONTAINER_IDLE_TIMEOUT_MS", "DASHBOARD_AUTH", "PREVIEW_ACCESS_AUD"]);
  assert.equal(p.vars.DASHBOARD_AUTH, "cloudflare");
  assert.equal(p.vars.CONTAINER_IDLE_TIMEOUT_MS, "1000");
  assert.equal(p.vars.ACCESS_AUD, p.vars.PREVIEW_ACCESS_AUD);
  assert.notEqual(p.vars.ACCESS_AUD, "a6acab2578806d53309922d135ad923c92c9071cbe22f34677ed763c09951170", "Production Access audience is forbidden");
  if (ready) assert.match(p.vars.PREVIEW_ACCESS_AUD, /^[a-f0-9]{64}$/, "Provision preview-only owner Access before deployment");
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validatePreview(JSON.parse(await readFile("wrangler.preview.jsonc", "utf8")), process.env.WORKERS_CI_BRANCH ?? "");
  console.log("Preview isolation configuration passed. This is not a deployment receipt.");
}
