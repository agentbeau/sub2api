// Isolated two-phase pipeline. Never invokes the production deploy script.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildEnvironment } from "./cloudflare-builds.mjs";
import { validatePreview } from "./preview-guard.mjs";
import { DASHBOARD_OBJECT_KEY, DASHBOARD_PANEL_FILE, imageDigest, PREPARED_IMAGE, sha256, sourceIdentity, verifyArtifact, verifyContainerImageArtifact, writeManifest } from "./deployment-artifact.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRANCH = "dagul/isolated-worker-preview";
const BUCKET = "sub2api-preview-isolated";
export function previewMetadata(env) {
  if (env.WORKERS_CI !== "1" || env.WORKERS_CI_BRANCH !== BRANCH) throw new Error("Only the isolated preview branch can use this pipeline");
  if (!/^[a-f0-9]{40}$/.test(env.WORKERS_CI_COMMIT_SHA ?? "")) throw new Error("Exact source revision required");
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")) throw new Error("Cloudflare account required");
  if (!/^[a-f0-9-]{36}$/.test(env.WORKERS_CI_BUILD_UUID ?? "")) throw new Error("Cloudflare build identity required");
  if (env.SKIP_DEPENDENCY_INSTALL !== "1") throw new Error("Dependency installation must run token-free inside the build phase");
  return { revision: env.WORKERS_CI_COMMIT_SHA, account: env.CLOUDFLARE_ACCOUNT_ID, buildId: env.WORKERS_CI_BUILD_UUID };
}
export function previewArtifactConfig(source) {
  const config = JSON.parse(JSON.stringify(source));
  delete config.$schema;
  config.main = "./worker/preview.js";
  config.no_bundle = true;
  config.find_additional_modules = true;
  config.rules = [{ type: "ESModule", globs: ["**/*.js"], fallthrough: false }, { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false }];
  config.previews.containers[0].image = PREPARED_IMAGE;
  delete config.previews.containers[0].image_build_context;
  return config;
}
export async function runPreviewPhase(phase, { root = ROOT, env = process.env, execute = execFileSync, fetcher = fetch } = {}) {
  if (!["build", "deploy"].includes(phase)) throw new Error("Usage: preview-builds.mjs build|deploy");
  const metadata = previewMetadata(env);
  const source = JSON.parse(await readFile(join(root, "wrangler.preview.jsonc"), "utf8"));
  validatePreview(source, env.WORKERS_CI_BRANCH);
  const checkSource = () => {
    const identity = sourceIdentity(root);
    if (identity.dirty || identity.revision !== metadata.revision) throw new Error("Preview checkout changed or is dirty");
  };
  checkSource();
  const clean = buildEnvironment(env);
  const output = join(root, ".wrangler/isolated-preview", metadata.buildId);
  const worker = join(output, "gateway");
  const image = join(output, "image");
  const receiptPath = join(output, "passed.json");
  const wrangler = join(root, "node_modules/.bin/wrangler");
  const run = (command, args, environment = clean, capture = false) => execute(command, args, {
    cwd: root, env: environment, encoding: "utf8", stdio: capture ? "pipe" : "inherit", maxBuffer: 10 * 1024 * 1024,
  });
  if (phase === "build") {
    await rm(output, { recursive: true, force: true });
    await mkdir(worker, { recursive: true });
    // Fail preflight before an expensive or partly configured build. See the pinned CI setup.
    run("cargo", ["--version"]); run("wasm-bindgen", ["--version"]); run("docker", ["info"]);
    run("npm", ["ci"]);
    run("npm", ["run", "verify"]);
    run(process.execPath, ["--test", "scripts/preview-guard.test.mjs", "scripts/preview-builds.test.mjs"]);
    run(process.execPath, ["scripts/build-container-image.mjs", image]);
    const temporary = join(output, "compile.json");
    const compile = JSON.parse(JSON.stringify(source));
    compile.main = join(root, source.main);
    compile.previews.containers[0].image = join(root, "container/Dockerfile");
    compile.previews.containers[0].image_build_context = join(root, "container");
    try {
      await writeFile(temporary, JSON.stringify(compile), { flag: "wx" });
      run(wrangler, ["deploy", "--dry-run", "--containers-rollout", "none", "--config", temporary, "--outdir", join(worker, "worker")]);
    } finally { await rm(temporary, { force: true }); }
    await readFile(join(worker, "worker/preview.js"));
    run(process.execPath, ["scripts/preview-runtime.mjs", join(worker, "worker/preview.js")]);
    await writeFile(join(worker, "wrangler.json"), JSON.stringify(previewArtifactConfig(source)), { flag: "wx" });
    checkSource();
    await writeManifest(worker, { revision: metadata.revision, dirty: false, install: "isolated-preview" });
    await verifyContainerImageArtifact(image, metadata.revision);
    await writeFile(receiptPath, JSON.stringify({ ...metadata, workerHash: await sha256(join(worker, "manifest.json")), imageHash: await sha256(join(image, "manifest.json")) }), { flag: "wx" });
    return;
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  for (const key of Object.keys(metadata)) if (receipt[key] !== metadata[key]) throw new Error("Build receipt does not match this build");
  if (receipt.workerHash !== await sha256(join(worker, "manifest.json")) || receipt.imageHash !== await sha256(join(image, "manifest.json"))) throw new Error("Manifest changed after build");
  await verifyArtifact(worker, metadata.revision, "isolated-preview");
  const manifest = await verifyContainerImageArtifact(image, metadata.revision);
  const config = JSON.parse(await readFile(join(worker, "wrangler.json"), "utf8"));
  if (JSON.stringify(config) !== JSON.stringify(previewArtifactConfig(source))) throw new Error("Prepared preview bindings differ from reviewed source");
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("Preview deploy credential missing");
  const deployEnv = { ...clean, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: metadata.account };
  // Require an explicitly provisioned bucket. Never create, import or copy production state here.
  const bucketResponse = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${metadata.account}/r2/buckets/${BUCKET}`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  if (!bucketResponse.ok || (await bucketResponse.json()).success !== true) throw new Error("Private preview bucket must be provisioned before deployment");
  run("docker", ["image", "load", "--input", join(image, "image.tar.gz")]);
  if (run("docker", ["image", "inspect", "--format", "{{.Id}}", manifest.image], clean, true).trim() !== manifest.imageId) throw new Error("Loaded image differs from tested image");
  run(wrangler, ["containers", "push", manifest.image], deployEnv);
  const remote = `registry.cloudflare.com/${metadata.account}/${manifest.image}`;
  const digests = JSON.parse(run("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", remote], clean, true));
  config.previews.containers[0].image = imageDigest(digests, metadata.account, manifest.image);
  const deployConfig = join(worker, "deploy.json");
  try {
    checkSource();
    run(wrangler, ["r2", "object", "put", `${BUCKET}/${DASHBOARD_OBJECT_KEY}`, "--file", join(image, DASHBOARD_PANEL_FILE), "--content-type", "text/html; charset=utf-8", "--remote"], deployEnv);
    await writeFile(deployConfig, JSON.stringify(config), { flag: "wx" });
    run(wrangler, ["preview", "--name", "isolated", "--no-bundle", "--config", deployConfig], deployEnv);
  } finally { await rm(deployConfig, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runPreviewPhase(process.argv[2]);
