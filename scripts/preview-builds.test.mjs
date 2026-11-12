import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { previewArtifactConfig, previewMetadata } from "./preview-builds.mjs";
const env = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "dagul/isolated-worker-preview", WORKERS_CI_COMMIT_SHA: "a".repeat(40), WORKERS_CI_BUILD_UUID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), SKIP_DEPENDENCY_INSTALL: "1" };
test("preview metadata is pinned to branch and full build identity", () => {
  assert.equal(previewMetadata(env).revision, env.WORKERS_CI_COMMIT_SHA);
  for (const field of Object.keys(env)) assert.throws(() => previewMetadata({ ...env, [field]: "" }));
  assert.throws(() => previewMetadata({ ...env, WORKERS_CI_BRANCH: "main" }));
});
test("prepared artifact keeps isolated bindings and prebuilt wrapper", async () => {
  const source = JSON.parse(await readFile(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8"));
  const config = previewArtifactConfig(source);
  assert.equal(config.main, "./worker/preview.js");
  assert.equal(config.no_bundle, true);
  assert.equal(config.containers, undefined);
  assert.equal(config.r2_buckets, undefined);
  assert.deepEqual(config.previews.r2_buckets, source.previews.r2_buckets);
  assert.match(config.previews.containers[0].image, /@sha256:/);
  assert.equal(config.previews.containers[0].image_build_context, undefined);
  assert.equal(source.previews.containers[0].image, "./container/Dockerfile");
});
