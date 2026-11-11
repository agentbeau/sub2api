// Read-only installation guard. Run before queueing production work and again inside its lock.
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function installationAllowed(live, target, event) {
  if (!["container", "worker", "none"].includes(live) || !["container", "worker"].includes(target)) throw new Error("Unknown gateway installation");
  return live === target || (live === "none" && event === "workflow_dispatch");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let ready = false;
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.log("::notice::Skipping deployment: Cloudflare repository secrets are not configured.");
  } else {
    const live = execFileSync(process.execPath, [new URL("./live-install.mjs", import.meta.url).pathname], { encoding: "utf8" }).trim();
    ready = installationAllowed(live, process.env.TARGET_INSTALL ?? "", process.env.EVENT_NAME ?? "");
    if (!ready) console.log(`::notice::Skipping deployment: sub2api is ${live}; only its existing installation is updated automatically. First deployment requires a manual run.`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
  else if (!ready) process.exitCode = 1;
}
