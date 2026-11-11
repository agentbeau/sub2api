// Checks runtime readiness and authentication separately. No model generation is billed.
// SUB2API_URL=... SUB2API_INSTALL=container|worker [SUB2API_KEY=...] node scripts/check-deployed.mjs
import { pathToFileURL } from "node:url";

async function retryFetch(fetcher, url, options, attempts) {
  const deadline = Date.now() + 120_000;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    let failure;
    try {
      response = await fetcher(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))) });
      if (![502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      failure = error;
    }
    if (attempt + 1 >= attempts || Date.now() + 5000 >= deadline) {
      if (response) return response;
      throw failure ?? new Error("request failed");
    }
    await response?.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

export async function checkDeployed({ base, install, key = "", fetcher = fetch, attempts = 12 }) {
  const origin = new URL(base);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("A plain HTTP(S) gateway URL is required");
  if (!["container", "worker"].includes(install)) throw new Error("SUB2API_INSTALL must be container or worker");
  const result = { ok: true, liveness: "failed", provider: install === "container" ? "failed" : "not applicable", anonymous: "failed", authenticated: key ? "failed" : "skipped", errors: [] };
  const failure = (message) => { result.ok = false; result.errors.push(message); };
  for (const [path, field] of [["/healthz", "liveness"], ...(install === "container" ? [["/readyz", "provider"]] : [])]) {
    try {
      const response = await retryFetch(fetcher, new URL(path, origin).href, {}, attempts);
      await response.body?.cancel();
      if (response.status !== 200) failure(`${path}: HTTP ${response.status}`);
      else result[field] = field === "provider" ? "ready" : "passed";
    } catch {
      failure(`${path}: request failed or timed out`);
    }
  }
  try {
    const response = await retryFetch(fetcher, new URL("/v1/models", origin).href, {}, attempts);
    await response.body?.cancel();
    if (![401, 403].includes(response.status)) failure(`Unauthenticated model listing: expected 401/403, got HTTP ${response.status}`);
    else result.anonymous = "denied";
  } catch {
    failure("Unauthenticated model listing: request failed or timed out");
  }
  if (key) {
    try {
      const response = await retryFetch(fetcher, new URL("/v1/models", origin).href, { headers: { authorization: `Bearer ${key}` } }, attempts);
      const body = await response.json().catch(() => null);
      if (response.status !== 200) failure(`Authenticated model listing: HTTP ${response.status}`);
      else if (!Array.isArray(body?.data) || !body.data.every((model) => typeof model?.id === "string")) failure("Authenticated model listing: invalid models response");
      else { result.authenticated = "passed"; result.models = body.data.length; }
    } catch {
      failure("Authenticated model listing: request failed or timed out");
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkDeployed({ base: process.env.SUB2API_URL ?? "", install: process.env.SUB2API_INSTALL ?? "", key: process.env.SUB2API_KEY ?? "" });
    console.log(`Gateway liveness: ${result.liveness}`);
    console.log(`Provider runtime: ${result.provider}`);
    console.log(`Unauthenticated access: ${result.anonymous}`);
    console.log(`Authenticated model listing: ${result.authenticated}${result.models === undefined ? "" : ` (${result.models} models)`}`);
    if (result.authenticated === "skipped") console.log("::notice::Authenticated provider checks skipped: no gateway test key is configured. Runtime readiness does not establish provider access.");
    for (const error of result.errors) console.error(error);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment check failed");
    process.exitCode = 1;
  }
}
