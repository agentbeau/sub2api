// Workers Builds entrypoint. Build children receive only approved non-deployment
// inputs; the deploy phase consumes the exact artifacts that passed every gate.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCurrentMain } from "./current-main.mjs";
import { consumeCiArtifacts, verifyCiProvenance } from "./consume-ci-artifacts.mjs";
import { sha256, verifyArtifact, verifyContainerImageArtifact } from "./deployment-artifact.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_INPUTS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
  "CI", "WORKERS_CI", "WORKERS_CI_BUILD_UUID", "WORKERS_CI_COMMIT_SHA", "WORKERS_CI_BRANCH",
  "SKIP_DEPENDENCY_INSTALL", "NODE_VERSION", "CPA_VERSION", "PANEL_VERSION", "PANEL_SHA256",
];

export function buildEnvironment(input) {
  const clean = Object.fromEntries(BUILD_INPUTS.filter(name => typeof input[name] === "string").map(name => [name, input[name]]));
  return { ...clean, CI: "true", GIT_TERMINAL_PROMPT: "0", WRANGLER_SEND_METRICS: "false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" };
}

export function buildMetadata(input) {
  if (input.WORKERS_CI !== "1" || input.WORKERS_CI_BRANCH !== "main") throw new Error("Only the Workers Builds production branch may run this pipeline");
  if (!["1", "true"].includes(input.SKIP_DEPENDENCY_INSTALL)) throw new Error("Set SKIP_DEPENDENCY_INSTALL=1 so dependency scripts run only inside the sanitized build phase");
  if (!/^[a-f0-9]{40}$/.test(input.WORKERS_CI_COMMIT_SHA ?? "")) throw new Error("Workers Builds must supply its full source revision");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.WORKERS_CI_BUILD_UUID ?? "")) throw new Error("Workers Builds must supply its build UUID");
  if (!/^[a-f0-9]{32}$/.test(input.CLOUDFLARE_ACCOUNT_ID ?? "")) throw new Error("The intended Cloudflare account ID is required");
  if (input.WRANGLER_CI_OVERRIDE_NAME && input.WRANGLER_CI_OVERRIDE_NAME !== "sub2api") throw new Error("This pipeline updates only the existing sub2api Worker");
  if (input.WRANGLER_CI_MATCH_TAG && !/^[a-f0-9]{32}$/.test(input.WRANGLER_CI_MATCH_TAG)) throw new Error("Invalid Cloudflare Worker identity");
  return { revision: input.WORKERS_CI_COMMIT_SHA, buildUuid: input.WORKERS_CI_BUILD_UUID, account: input.CLOUDFLARE_ACCOUNT_ID };
}

function executeCommand(command, args, { cwd, env, capture = false }) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", maxBuffer: 10 * 1024 * 1024 })?.trim() ?? "";
}

async function checkCheckout(root, metadata, env, execute) {
  const options = { cwd: root, env, capture: true };
  const current = await execute("git", ["rev-parse", "HEAD"], options);
  const status = await execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], options);
  if (current.trim() !== metadata.revision || status.trim() !== "") throw new Error("Checkout is dirty or does not match the Workers Builds revision");
}

function outputPaths(root, metadata) {
  const directory = join(root, ".wrangler/cloudflare-builds", metadata.buildUuid);
  return { directory, worker: join(directory, "container-worker"), image: join(directory, "container-image"), receipt: join(directory, "passed.json") };
}

async function checkedReceipt(paths, metadata, verifySource) {
  const receipt = JSON.parse(await readFile(paths.receipt, "utf8"));
  if (receipt.version !== 1 || receipt.revision !== metadata.revision || receipt.buildUuid !== metadata.buildUuid || receipt.account !== metadata.account) throw new Error("No successful build receipt for this build, account and source revision");
  await verifyArtifact(paths.worker, metadata.revision, "container");
  await verifyContainerImageArtifact(paths.image, metadata.revision);
  if (receipt.workerManifest !== await sha256(join(paths.worker, "manifest.json")) || receipt.imageManifest !== await sha256(join(paths.image, "manifest.json"))) throw new Error("Artifact manifests changed after the successful build");
  await verifySource(receipt.source, metadata.revision);
}

export async function runPhase(phase, { root = ROOT, environment = process.env, execute = executeCommand, consume = consumeCiArtifacts, verifySource = verifyCiProvenance } = {}) {
  if (!["build", "validate", "deploy"].includes(phase)) throw new Error("Usage: node scripts/cloudflare-builds.mjs build|validate|deploy");
  const metadata = buildMetadata(environment);
  const clean = buildEnvironment(environment);
  const checkMain = () => checkCurrentMain(root, metadata.revision, clean, (command, args, options) => execute(command, args, { ...options, capture: true }));
  const paths = outputPaths(root, metadata);
  if (phase === "build") {
    // A retried build must not reuse an earlier success after any failed gate.
    await rm(paths.receipt, { force: true });
    await checkCheckout(root, metadata, clean, execute);
    await checkMain();
    await rm(paths.directory, { recursive: true, force: true });
    await mkdir(paths.directory, { recursive: true });
    const env = { ...clean };
    console.log(`Workers Builds deploy token present in build phase: ${Boolean(environment.CLOUDFLARE_API_TOKEN)}; excluded from child commands.`);
    const command = (binary, args) => execute(binary, args, { cwd: root, env });
    await command("npm", ["ci"]);
    await command(process.execPath, ["--test", "scripts/deployment.test.mjs", "scripts/deploy-prepared.test.mjs", "scripts/cloudflare-builds.test.mjs", "scripts/consume-ci-artifacts.test.mjs", "scripts/publish-ci-artifacts.test.mjs", "container/brand-panel/brand.test.mjs"]);
    const source = await consume({ root, revision: metadata.revision, worker: paths.worker, image: paths.image, directory: paths.directory, env, execute });
    await command("npm", ["run", "test:runtime", "--", join(paths.worker, "worker/index.js")]);
    await checkCheckout(root, metadata, clean, execute);
    await verifyArtifact(paths.worker, metadata.revision, "container");
    await verifyContainerImageArtifact(paths.image, metadata.revision);
    const receipt = { version: 1, ...metadata, source, workerManifest: await sha256(join(paths.worker, "manifest.json")), imageManifest: await sha256(join(paths.image, "manifest.json")) };
    await writeFile(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    console.log(`All build gates passed for ${metadata.revision} (${metadata.buildUuid}).`);
    return paths;
  }

  await checkCheckout(root, metadata, clean, execute);
  await checkedReceipt(paths, metadata, verifySource);
  if (phase === "validate") {
    await checkMain();
    console.log("Validated the exact checked artifacts; no deployment was requested.");
    return paths;
  }
  if (!environment.CLOUDFLARE_API_TOKEN) throw new Error("Workers Builds did not supply a deployment API token");
  const env = { ...clean, CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: metadata.account, CHECKED_SHA: metadata.revision, SUB2API_EXPECTED_MAIN_SHA: metadata.revision };
  // These platform identity guards make live API calls. Restore them only here,
  // after token-free packaging, and never forward optional runtime secret inputs.
  for (const name of ["WRANGLER_CI_MATCH_TAG", "WRANGLER_CI_OVERRIDE_NAME"]) if (environment[name]) env[name] = environment[name];
  const live = await execute(process.execPath, ["scripts/live-install.mjs"], { cwd: root, env, capture: true });
  if (live.trim() !== "container") throw new Error("Workers Builds may update only the existing container installation");
  await checkMain();
  const output = await execute(process.execPath, ["scripts/deploy-prepared.mjs", "container", paths.worker, paths.image], { cwd: root, env, capture: true });
  console.log(output);
  const url = output.match(/https:\/\/sub2api\.[a-z0-9-]+\.workers\.dev\b/)?.[0];
  if (!url) throw new Error("Deployment returned no sub2api URL; live verification could not run");
  await execute(process.execPath, ["scripts/check-deployed.mjs"], { cwd: root, env: { ...clean, SUB2API_URL: url, SUB2API_INSTALL: "container" } });
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runPhase(process.argv[2]); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Cloudflare build pipeline failed");
    process.exitCode = 1;
  }
}
