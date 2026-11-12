// Deploy only checksummed artifacts from the intended CI revision. No compiler or image build runs here.
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactConfig, DASHBOARD_OBJECT_KEY, DASHBOARD_PANEL_FILE, deploymentSecrets, imageDigest, verifyArtifact, verifyContainerImageArtifact } from "./deployment-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [install, artifactPath, imagePath] = process.argv.slice(2);
if (!["container", "worker"].includes(install) || !artifactPath) throw new Error("Usage: node scripts/deploy-prepared.mjs container|worker artifact-directory [image-directory]");
const revision = process.env.CHECKED_SHA ?? "";
const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (revision !== current) throw new Error("Checkout does not match the verified source revision");
const directory = resolve(artifactPath);
await verifyArtifact(directory, revision, install);
const source = JSON.parse(await readFile(join(directory, "wrangler.json"), "utf8"));
if (source.name !== "sub2api" || source.build) throw new Error("Unexpected prepared Worker configuration");
let config = source;
const wrangler = join(root, "node_modules/.bin/wrangler");
const childEnv = { ...process.env };
delete childEnv.SUB2API_DASHBOARD_PASSWORD;
delete childEnv.SUB2API_MANAGEMENT_KEY;
const live = execFileSync(process.execPath, [join(root, "scripts/live-install.mjs")], { cwd: root, encoding: "utf8", env: childEnv }).trim();
if (live !== install && live !== "none") throw new Error("Refusing to replace the other gateway installation");
// Validate first-install secrets before any bucket creation, image push or Worker deployment.
const secrets = deploymentSecrets(install, live === "none", process.env.SUB2API_DASHBOARD_PASSWORD ?? "", process.env.SUB2API_MANAGEMENT_KEY ?? "");

if (install === "container") {
  if (!imagePath) throw new Error("A tested image artifact is required");
  const images = resolve(imagePath);
  const manifest = await verifyContainerImageArtifact(images, revision);
  execFileSync("docker", ["image", "load", "--input", join(images, "image.tar.gz")], { stdio: "inherit", env: childEnv });
  const loadedId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", manifest.image], { encoding: "utf8", env: childEnv }).trim();
  if (loadedId !== manifest.imageId) throw new Error("Loaded container image differs from the smoke-tested image");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!/^[a-f0-9]{32}$/.test(account) || token === "") throw new Error("Cloudflare credentials are required");
  const bucket = config.r2_buckets?.find((binding) => binding.binding === "STATE")?.bucket_name;
  if (bucket !== "sub2api") throw new Error("The existing sub2api state bucket binding is required");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (response.status === 404) execFileSync(wrangler, ["r2", "bucket", "create", bucket], { cwd: root, stdio: "inherit", env: childEnv });
  else if (!response.ok || body?.success !== true) throw new Error(`Could not verify the existing state bucket (HTTP ${response.status}); no bucket changes attempted`);
  execFileSync(wrangler, ["containers", "push", manifest.image], { cwd: root, stdio: "inherit", env: childEnv });
  const remoteTag = `registry.cloudflare.com/${account}/${manifest.image}`;
  const digests = JSON.parse(execFileSync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", remoteTag], { encoding: "utf8", env: childEnv }));
  const pinned = imageDigest(digests, account, manifest.image);
  config = artifactConfig(source, install, pinned);
  // Publish the image's checksummed panel before the Worker switches to serving
  // it from R2. Dashboard viewing then needs no provider/container request.
  execFileSync(wrangler, ["r2", "object", "put", `${bucket}/${DASHBOARD_OBJECT_KEY}`, "--file", join(images, DASHBOARD_PANEL_FILE), "--content-type", "text/html; charset=utf-8", "--cache-control", "no-cache", "--remote"], { cwd: root, stdio: "inherit", env: childEnv });
  console.log(`Published ${DASHBOARD_OBJECT_KEY} from the tested image (${manifest.files[DASHBOARD_PANEL_FILE]})`);
  console.log(`Deploying the smoke-tested image by digest: ${pinned}`);
}

// Keep paths relative to the artifact; this extra file is removed before the script exits.
const deploymentConfig = join(directory, "deploy.json");
let secretDirectory;
try {
  await writeFile(deploymentConfig, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  const args = ["deploy", "--no-bundle", "--config", deploymentConfig];
  if (secrets) {
    secretDirectory = await mkdtemp(join(tmpdir(), "sub2api-secrets-"));
    const secretFile = join(secretDirectory, "secrets.json");
    await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
    args.push("--secrets-file", secretFile);
  }
  const output = execFileSync(wrangler, args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: childEnv });
  process.stdout.write(output);
  const url = output.match(/https:\/\/sub2api\.[a-z0-9-]+\.workers\.dev\b/)?.[0];
  if (!url) throw new Error("Deployment finished, but its workers.dev URL was not found; runtime verification is still required");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\n`);
} finally {
  await rm(deploymentConfig, { force: true });
  if (secretDirectory) await rm(secretDirectory, { recursive: true, force: true });
}
