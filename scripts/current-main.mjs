import { execFileSync } from "node:child_process";

const REPOSITORY = "https://github.com/agentbeau/sub2api.git";
const GIT_INPUTS = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH",
];

// This read uses only the public repository and never inherits deployment tokens.
// A successful check is not an atomic reservation of the remote main revision.
export async function checkCurrentMain(root, revision, environment, execute = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("A full expected main revision is required");
  const env = Object.fromEntries(GIT_INPUTS.filter(name => typeof environment[name] === "string").map(name => [name, environment[name]]));
  env.GIT_TERMINAL_PROMPT = "0";
  const remote = await execute("git", ["ls-remote", "--exit-code", REPOSITORY, "refs/heads/main"], {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  if (remote.trim() !== `${revision}\trefs/heads/main`) throw new Error("This checked revision is no longer current main; refusing a stale deployment");
}
