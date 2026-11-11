// Package the already-built Worker once, without rerunning a custom build or touching Cloudflare.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { artifactConfig, sourceIdentity, writeManifest } from "./deployment-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const install = process.argv[2];
if (!["container", "worker"].includes(install)) throw new Error("Usage: node scripts/prepare-deployment.mjs container|worker [output-directory]");
const output = resolve(process.argv[3] ?? join(root, ".wrangler/artifacts", install === "container" ? "container-worker" : "worker-only"));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) throw new Error("The artifact output directory must be empty");
const sourceRoot = install === "container" ? root : join(root, "worker");
const sourceFile = join(sourceRoot, "wrangler.jsonc");
const parsed = ts.parseConfigFileTextToJson(sourceFile, await readFile(sourceFile, "utf8"));
if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
const source = parsed.config;
const before = sourceIdentity(root);
const buildConfig = JSON.parse(JSON.stringify(source));
delete buildConfig.build;
delete buildConfig.$schema;
buildConfig.main = resolve(sourceRoot, source.main);
if (buildConfig.assets) buildConfig.assets.directory = resolve(sourceRoot, buildConfig.assets.directory);
if (buildConfig.tsconfig) buildConfig.tsconfig = resolve(sourceRoot, buildConfig.tsconfig);
for (const container of buildConfig.containers ?? []) {
  if (container.image.startsWith(".")) container.image = resolve(sourceRoot, container.image);
  if (container.image_build_context) container.image_build_context = resolve(sourceRoot, container.image_build_context);
}
await mkdir(join(root, ".wrangler"), { recursive: true });
const temporary = await mkdtemp(join(root, ".wrangler/prepare-"));
try {
  const config = join(temporary, "wrangler.json");
  await writeFile(config, JSON.stringify(buildConfig));
  execFileSync(join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--containers-rollout", "none", "--config", config, "--outdir", join(output, "worker")], { cwd: root, stdio: "inherit" });
  await stat(join(output, "worker/index.js"));
  if (source.assets) await cp(resolve(sourceRoot, source.assets.directory), join(output, "public"), { recursive: true });
  await writeFile(join(output, "wrangler.json"), `${JSON.stringify(artifactConfig(source, install), null, 2)}\n`);
  // Confirm Wrangler accepts the actual prebuilt modules and their relative Wasm/asset paths.
  execFileSync(join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--no-bundle", "--containers-rollout", "none", "--config", join(output, "wrangler.json")], { cwd: root, stdio: "inherit" });
  const after = sourceIdentity(root);
  const dirty = before.dirty || after.dirty || before.revision !== after.revision;
  await writeManifest(output, { revision: before.revision, dirty, install });
  console.log(`Prepared ${install} artifact for ${before.revision}${dirty ? " (dirty local source; deployment refused)" : ""}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
