import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PREPARED_IMAGE = `registry.cloudflare.com/${"0".repeat(32)}/sub2api-cpa@sha256:${"0".repeat(64)}`;
export const DASHBOARD_PANEL_FILE = "management.html";
export const DASHBOARD_OBJECT_KEY = "dashboard/management.html";
const DIGEST_IMAGE = /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

export function sourceIdentity(root) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  return { revision, dirty: status.trim() !== "" };
}

export function deploymentSecrets(install, isNew, password = "", management = "") {
  if (!password && !management && !isNew) return null;
  if (!password || !management) throw new Error("First deployment or secret updates require both SUB2API_DASHBOARD_PASSWORD and SUB2API_MANAGEMENT_KEY");
  const valid = install === "container" ? (value) => /^[A-Za-z0-9_-]{32,}$/.test(value) : (value) => value.length >= 16;
  if (!valid(password) || !valid(management) || password === management) throw new Error("Deployment secrets do not meet the installation's length, format, and separation requirements");
  return { DASHBOARD_PASSWORD: password, MANAGEMENT_KEY: management };
}

export function artifactConfig(source, install, image = PREPARED_IMAGE) {
  const config = JSON.parse(JSON.stringify(source));
  if (!["container", "worker"].includes(install)) throw new Error("Unknown install");
  delete config.$schema;
  delete config.build;
  delete config.tsconfig;
  config.main = "./worker/index.js";
  config.no_bundle = true;
  config.find_additional_modules = true;
  config.rules = [
    { type: "ESModule", globs: ["**/*.js"], fallthrough: false },
    { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false },
  ];
  if (install === "container") {
    if (!DIGEST_IMAGE.test(image)) throw new Error("A Cloudflare registry image pinned by digest is required");
    if (config.containers?.length !== 1 || config.containers[0].class_name !== "Cpa") throw new Error("Expected the existing Cpa container");
    config.containers[0].image = image;
    delete config.containers[0].image_build_context;
    delete config.containers[0].image_vars;
  }
  if (config.assets) config.assets.directory = "./public";
  return config;
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function filesIn(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...await filesIn(directory, path));
    else if (entry.isFile() && path !== "manifest.json") files.push(path);
    else if (!entry.isFile()) throw new Error(`Unsupported artifact file: ${path}`);
  }
  return files.sort();
}

export async function writeManifest(directory, metadata) {
  if (!/^[a-f0-9]{40}$/.test(metadata.revision ?? "")) throw new Error("A full source revision is required");
  const files = {};
  for (const path of await filesIn(directory)) files[path] = await sha256(join(directory, path));
  if (Object.keys(files).length === 0) throw new Error("Cannot package an empty artifact");
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify({ ...metadata, files }, null, 2)}\n`);
}

export async function verifyArtifact(directory, revision, install) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(revision ?? "") || manifest.revision !== revision) throw new Error("Artifact source revision does not match the verified commit");
  if (manifest.install !== install) throw new Error("Artifact install does not match the requested deployment");
  if (manifest.dirty !== false) throw new Error("Artifact was built from a dirty or unverified source tree and cannot be deployed");
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("Missing artifact checksums");
  const expected = Object.keys(manifest.files).sort();
  if (expected.length === 0 || expected.some((path) => path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..") || path === "manifest.json")) throw new Error("Invalid artifact path");
  const actual = await filesIn(directory);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Artifact file set changed after verification");
  for (const path of expected) {
    if (await sha256(join(directory, path)) !== manifest.files[path]) throw new Error(`Artifact checksum mismatch: ${path}`);
  }
  return manifest;
}

export async function verifyContainerImageArtifact(directory, revision) {
  const manifest = await verifyArtifact(directory, revision, "container-image");
  if (!/^sub2api-cpa:[a-f0-9]{12}-\d+-\d+$/.test(manifest.image ?? "") || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId ?? "")) throw new Error("Invalid tested image identity");
  if (!/^[a-f0-9]{64}$/.test(manifest.files["image.tar.gz"] ?? "")) throw new Error("The tested image archive is required");
  if (!/^[a-f0-9]{64}$/.test(manifest.files[DASHBOARD_PANEL_FILE] ?? "")) throw new Error("The checksummed provider dashboard is required");
  return manifest;
}

export function imageDigest(digests, account, tag) {
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid Cloudflare account ID");
  const repository = tag.split(":")[0];
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(repository)) throw new Error("Invalid local image repository");
  const prefix = `registry.cloudflare.com/${account}/${repository}@sha256:`;
  const matches = Array.isArray(digests) ? digests.filter((value) => typeof value === "string" && value.startsWith(prefix) && DIGEST_IMAGE.test(value)) : [];
  if (matches.length !== 1) throw new Error("Could not identify one pushed image digest for this account and repository");
  return matches[0];
}
