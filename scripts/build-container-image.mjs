// Build once, smoke-test that exact image, and save it for the credential-bearing deploy job.
import { execFileSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceIdentity, writeManifest } from "./deployment-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, ".wrangler/artifacts/container-image"));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) throw new Error("The image artifact output directory must be empty");
const before = sourceIdentity(root);
const { revision } = before;
const run = process.env.GITHUB_RUN_ID ?? String(Date.now());
const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
if (!/^[a-f0-9]{40}$/.test(revision) || !/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error("Invalid build identity");
const image = `sub2api-cpa:${revision.slice(0, 12)}-${run}-${attempt}`;
const args = ["build", "--pull", "--platform", "linux/amd64", "--tag", image, "--label", `org.opencontainers.image.revision=${revision}`];
for (const name of ["CPA_VERSION", "PANEL_VERSION", "PANEL_SHA256"]) {
  const value = process.env[name];
  if (value) args.push("--build-arg", `${name}=${value}`);
}
// Dockerfile's latest releases are resolved only here; deployment never rebuilds this image.
execFileSync("docker", [...args, "container"], { cwd: root, stdio: "inherit" });
const imageId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8" }).trim();
execFileSync("sh", ["test/container-smoke.sh", "--prebuilt"], { cwd: root, stdio: "inherit", env: { ...process.env, IMAGE: image } });
execFileSync("docker", ["image", "save", "--output", join(output, "image.tar"), image], { stdio: "inherit" });
execFileSync("gzip", ["-1", join(output, "image.tar")], { stdio: "inherit" });
const after = sourceIdentity(root);
const dirty = before.dirty || after.dirty || before.revision !== after.revision;
await writeManifest(output, { revision, dirty, install: "container-image", image, imageId });
console.log(`Saved the tested image ${image} (${imageId})`);
