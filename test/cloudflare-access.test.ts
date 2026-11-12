import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { accessRequired, crossOriginWrite, dashboardAccess, isBrowserRoute, withoutAccessCredentials } from "../src/access.ts";
import { handle, type GatewayConfig } from "../src/gateway.ts";
import { issueSession, SESSION_COOKIE } from "../worker/src/session.ts";
import type { Env } from "../src/env.ts";

vi.mock("cloudflare:workers", () => {
  class PlatformEntrypoint<Environment> {
    constructor(protected readonly ctx: DurableObjectState, protected readonly env: Environment) {}
  }
  return { DurableObject: PlatformEntrypoint, WorkerEntrypoint: PlatformEntrypoint };
});
import worker from "../src/index.ts";

const ORIGIN = "https://api.agentbeau.dev";
const AUD = "test-access-application";
const PASSWORD = "existing-dashboard-password-0123456789abcdef";
const PANEL = "<!doctype html><title>Console</title><main>Native console</main>";
const nativeContext = (aud = AUD) => ({ access: { aud } }) as unknown as ExecutionContext;

function fixture() {
  const forwarded: Request[] = [];
  const rpc: Request[] = [];
  const fetch = vi.fn(async (request: Request) => { forwarded.push(request); return new Response("native API"); });
  const fetchWithAccess = vi.fn(async (request: Request) => { rpc.push(request); return new Response("native management"); });
  const getByName = vi.fn(() => ({ fetch, fetchWithAccess }));
  const get = vi.fn(async (key: string) => key === "dashboard/management.html"
    ? { body: new Response(PANEL).body, httpEtag: '"checked"' } : null);
  const limit = vi.fn(async () => ({ success: true }));
  const env = {
    DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: AUD, DASHBOARD_PASSWORD: PASSWORD,
    STATE: { get }, LOGIN_LIMIT: { limit }, CPA: { getByName },
  } as unknown as Env;
  return { env, get, getByName, limit, forwarded, rpc };
}

function config(authenticated: boolean): GatewayConfig {
  return {
    dashboardPassword: PASSWORD, dashboardAccess: authenticated,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    apiAccess: { authorize: async () => "denied", invalidate() {} },
    loginLimiter: { limit: async () => { throw new Error("Cloudflare login must not use the password limiter"); } },
  };
}

describe("Cloudflare replaces the initial password login", () => {
  it("trusts only the matching platform audience and fails closed on invalid configuration", () => {
    expect(dashboardAccess({})).toBeUndefined();
    expect(dashboardAccess({ DASHBOARD_AUTH: "cloudflare" }, nativeContext())).toBe(false);
    expect(dashboardAccess({ DASHBOARD_AUTH: "typo", ACCESS_AUD: AUD }, nativeContext())).toBe(false);
    expect(dashboardAccess({ DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: AUD })).toBe(false);
    expect(dashboardAccess({ DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: AUD }, nativeContext("another-app"))).toBe(false);
    expect(dashboardAccess({ DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: AUD }, nativeContext())).toBe(true);
    expect(accessRequired().status).toBe(401);
    expect(isBrowserRoute("api")).toBe(false);
    expect(isBrowserRoute("oauth-callback")).toBe(true);
  });

  it.each(["/", "/login", "/management.html", "/provider-panel.html", "/runtime/status", "/v8/management/config", "/callback?code=x&state=y"])("rejects old sessions and forged identity headers at %s without contacting the container", async (path) => {
    const state = fixture();
    const cookie = `${SESSION_COOKIE}=${await issueSession(PASSWORD, Math.floor(Date.now() / 1000))}`;
    const request = new Request(`${ORIGIN}${path}`, { headers: {
      cookie, "cf-access-jwt-assertion": "forged", "cf-access-authenticated-user-email": "owner@example.com",
      authorization: "Bearer native-management-key",
    } });
    expect((await worker.fetch(request, state.env)).status).toBe(401);
    expect((await worker.fetch(request, state.env, nativeContext("another-app"))).status).toBe(401);
    expect(state.getByName).not.toHaveBeenCalled();
    expect(state.get).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"])("does not serve or validate a password form for %s /login", async (method) => {
    const state = fixture();
    const request = new Request(`${ORIGIN}/login`, { method, ...(method === "POST" ? { body: "password=old-password" } : {}) });
    const response = await worker.fetch(request, state.env, nativeContext());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/management.html");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(request.bodyUsed).toBe(false);
    expect(state.limit).not.toHaveBeenCalled();
    expect(state.getByName).not.toHaveBeenCalled();
  });

  it.each(["/management.html", "/provider-panel.html"])("serves %s directly after Cloudflare authentication without a provider request", async (path) => {
    const state = fixture();
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`), state.env, nativeContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PANEL);
    expect(state.getByName).not.toHaveBeenCalled();
    expect(state.limit).not.toHaveBeenCalled();
  });

  it("uses the private RPC only for authenticated browser operations and strips Access credentials", async () => {
    const state = fixture();
    const response = await worker.fetch(new Request(`${ORIGIN}/v8/management/config`, { headers: {
      cookie: "CF_Authorization=private", "cf-access-jwt-assertion": "private-jwt", authorization: "Bearer native-management-key",
    } }), state.env, nativeContext());
    expect(await response.text()).toBe("native management");
    expect(state.forwarded).toHaveLength(0);
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0]?.headers.has("cookie")).toBe(false);
    expect(state.rpc[0]?.headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(state.rpc[0]?.headers.get("authorization")).toBe("Bearer native-management-key");
  });

  it("rejects cross-origin browser writes before the management RPC", async () => {
    const state = fixture();
    const request = new Request(`${ORIGIN}/v8/management/config`, { method: "POST", headers: { origin: "https://untrusted.example" }, body: "{}" });
    expect((await worker.fetch(request, state.env, nativeContext())).status).toBe(403);
    expect(state.getByName).not.toHaveBeenCalled();
    expect(crossOriginWrite(new Request(`${ORIGIN}/runtime/start`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } }))).toBe(true);
    expect(crossOriginWrite(new Request(`${ORIGIN}/v8/management/config`, { method: "POST", headers: { origin: ORIGIN } }))).toBe(false);
  });

  it("leaves model API calls on the normal client-key path regardless of Cloudflare session", async () => {
    for (const ctx of [undefined, nativeContext()]) {
      const state = fixture();
      const request = new Request(`${ORIGIN}/v1/responses`, { method: "POST", body: "{}", headers: { authorization: "Bearer client-key" } });
      expect(await (await worker.fetch(request, state.env, ctx)).text()).toBe("native API");
      expect(state.forwarded).toEqual([request]);
      expect(state.rpc).toHaveLength(0);
      const forward = vi.fn(async () => new Response("should not be called"));
      expect((await handle(new Request(`${ORIGIN}/v1/responses`), config(ctx !== undefined), forward)).status).toBe(401);
      expect(forward).not.toHaveBeenCalled();
    }
  });

  it("keeps Rust fail-closed for direct object calls with legacy cookies", async () => {
    const cookie = `${SESSION_COOKIE}=${await issueSession(PASSWORD, Math.floor(Date.now() / 1000))}`;
    const forward = vi.fn(async () => new Response("never"));
    for (const path of ["/login", "/management.html", "/runtime/status", "/callback?state=old&code=x"]) {
      expect((await handle(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), config(false), forward)).status).toBe(401);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it("preserves the provider callback path after Cloudflare login", async () => {
    const seen: Request[] = [];
    const response = await handle(new Request(`${ORIGIN}/callback?state=provider-state&code=provider-code`), config(true), async request => {
      seen.push(request); return Response.json({ status: "ok" });
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Login received");
    expect(seen[0]?.url).toBe(`${ORIGIN}/v0/management/oauth-callback?state=provider-state&code=provider-code`);
  });

  it("uses native Cloudflare logout and clears the obsolete app cookie", async () => {
    const state = fixture();
    const response = await worker.fetch(new Request(`${ORIGIN}/logout`), state.env, nativeContext());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/cdn-cgi/access/logout");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(state.getByName).not.toHaveBeenCalled();
  });

  it("removes identity headers without buffering model streams or changing API credentials", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode("model-request")); controller.close(); } }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}/v1/responses`, { method: "POST", body, duplex: "half", headers: {
      authorization: "Bearer client-key", originator: "native-client", "cf-access-jwt-assertion": "private",
      "cf-access-client-secret": "private", "cf-access-authenticated-user-email": "private", cookie: "CF_Authorization=private",
    } } as RequestInit);
    const clean = withoutAccessCredentials(request);
    expect(pulls).toBe(0);
    expect(clean.headers.get("authorization")).toBe("Bearer client-key");
    expect(clean.headers.get("originator")).toBe("native-client");
    expect([...clean.headers.keys()].some(name => name === "cookie" || name.startsWith("cf-access-"))).toBe(false);
    expect(await clean.text()).toBe("model-request");
    const plain = new Request(`${ORIGIN}/healthz`);
    expect(withoutAccessCredentials(plain)).toBe(plain);
  });

  it("retains the production audience and only exempts model and existing health paths from Access", () => {
    const settings = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    const access = JSON.parse(readFileSync(new URL("../ops/dashboard-access.json", import.meta.url), "utf8"));
    expect(settings.vars.DASHBOARD_AUTH).toBe("cloudflare");
    expect(settings.vars.ACCESS_AUD).toBe(access.aud);
    expect(settings.access).toBeUndefined();
    expect(access.application.allowed_idps).toHaveLength(1);
    expect(access.application.auto_redirect_to_identity).toBe(true);
    expect(access.application.destinations.map((destination: { uri: string }) => destination.uri)).toEqual(["api.agentbeau.dev", "sub2api.agentbeau.workers.dev"]);
    for (const destination of access.application.destinations) {
      expect(destination.type).toBe("public");
      expect(destination.overrides.map((override: { path_pattern: string }) => override.path_pattern)).toEqual(["/v1", "/v1/*", "/v1beta", "/v1beta/*", "/healthz", "/readyz"]);
    }
  });
});
