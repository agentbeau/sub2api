import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validatePreview } from "./preview-guard.mjs";
const source = JSON.parse(await readFile(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8"));
const branch = "dagul/isolated-worker-preview";
const ready = () => { const c = JSON.parse(JSON.stringify(source)); c.previews.vars.ACCESS_AUD = c.previews.vars.PREVIEW_ACCESS_AUD = "b".repeat(64); return c; };
test("template isolated but not deployable before identity provisioning", () => {
  assert.equal(validatePreview(source, branch, { ready: false }), true);
  assert.throws(() => validatePreview(source, branch));
});
test("provisioned isolated identity passes", () => assert.equal(validatePreview(ready(), branch), true));
test("main and other branches cannot deploy", () => {
  for (const value of ["main", "", "feature/test"]) assert.throws(() => validatePreview(ready(), value));
});
test("production bucket, foreign DO and extra binding forbidden", () => {
  for (const mutate of [c => { c.previews.r2_buckets[0].bucket_name = "sub2api"; }, c => { c.previews.durable_objects.bindings[0].script_name = "sub2api"; }, c => { c.previews.services = [{ binding: "PROD", service: "sub2api" }]; }, c => { c.routes = [{ pattern: "api.agentbeau.dev", custom_domain: true }]; }, c => { c.main = "src/index.ts"; }]) {
    const c = ready(); mutate(c); assert.throws(() => validatePreview(c, branch));
  }
});
test("production audience and secrets in vars forbidden", () => {
  const c = ready(); c.previews.vars.ACCESS_AUD = c.previews.vars.PREVIEW_ACCESS_AUD = "a6acab2578806d53309922d135ad923c92c9071cbe22f34677ed763c09951170";
  assert.throws(() => validatePreview(c, branch));
  const d = ready(); d.previews.vars.MANAGEMENT_KEY = "secret"; assert.throws(() => validatePreview(d, branch));
});
