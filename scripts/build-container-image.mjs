// Build once, smoke-test that exact image, and save it for the credential-bearing deploy job.
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_PANEL_FILE, sourceIdentity, writeManifest } from "./deployment-artifact.mjs";

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
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Docker did not return an immutable image identity");
execFileSync("sh", ["test/container-smoke.sh", "--prebuilt"], { cwd: root, stdio: "inherit", env: { ...process.env, IMAGE: image } });
// Read the panel from this exact tested image. Creating a stopped container does
// not run CPA; neither extraction nor the later R2 upload changes the image.
const panelContainer = execFileSync("docker", ["container", "create", "--pull=never", "--platform", "linux/amd64", "--entrypoint", "/bin/true", imageId], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{64}$/.test(panelContainer)) throw new Error("Docker did not return a panel extraction container");
try {
  const panelPath = join(output, DASHBOARD_PANEL_FILE);
  execFileSync("docker", ["container", "cp", `${panelContainer}:/panel/management.html`, panelPath], { stdio: "inherit" });
  const panel = await lstat(panelPath);
  if (!panel.isFile() || panel.size === 0) throw new Error("The tested image has no regular, non-empty provider dashboard");
} finally {
  execFileSync("docker", ["container", "rm", panelContainer], { stdio: "ignore" });
}
execFileSync("docker", ["image", "save", "--output", join(output, "image.tar"), image], { stdio: "inherit" });
execFileSync("gzip", ["-1", join(output, "image.tar")], { stdio: "inherit" });
const after = sourceIdentity(root);
const dirty = before.dirty || after.dirty || before.revision !== after.revision;
await writeManifest(output, { revision, dirty, install: "container-image", image, imageId });
console.log(`Saved the tested image ${image} (${imageId}) and its exact provider dashboard`);
