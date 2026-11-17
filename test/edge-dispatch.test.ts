import { describe, expect, it, vi } from "vitest";

// Cpa's platform class exports are not instantiated by this Worker entrypoint. The DO binding
// is the external boundary below; lifecycle behavior has its own controller/runtime coverage.
vi.mock("../src/cpa.ts", () => ({ Cpa: Symbol("Cpa"), R2Bridge: Symbol("R2Bridge") }));
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { issueSession, SESSION_COOKIE } from "../worker/src/session.ts";

const PASSWORD = "long-dashboard-password-0123456789";

function binding(poolOwner?: string, poolEnabled = poolOwner !== undefined) {
  const names: string[] = [];
  const requests: Request[] = [];
  const response = new Response("from the singleton");
  const reads: string[] = [];
  const panel = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("<html>tested provider panel</html>")); controller.close(); } });
  const id: DurableObjectId = { toString: () => "test-id", equals: () => true };
  const stub = {
    id,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input instanceof Request && init === undefined ? input : new Request(input, init));
      return response;
    },
    connect: () => { throw new Error("HTTP routing must not open raw TCP"); },
  };
  const ownerRequests: Request[] = [];
  const ownerStub = {
    fetchWithAccess: async (request: Request) => { ownerRequests.push(request); return new Response("callback owner"); },
  };
  const coordinator = { poolOAuthOwner: async () => poolOwner };
  const namespace: DurableObjectNamespace = {
    newUniqueId: () => { throw new Error("Must preserve the singleton"); },
    idFromName: () => { throw new Error("Use the existing named object"); },
    idFromString: (value) => ({ toString: () => value, equals: () => true }),
    get: () => ownerStub as never,
    getByName: (name) => { names.push(name); return (name === "cf-pool-coordinator-v1" ? coordinator : stub) as never; },
    jurisdiction: () => { throw new Error("Must preserve existing placement"); },
  };
  return {
    env: { CPA: namespace as unknown as Env["CPA"], DASHBOARD_PASSWORD: PASSWORD, LOGIN_LIMIT: { limit: async () => ({ success: true }) },
      ...(poolEnabled ? { POOL_FENCING_ENABLED: "true", DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: "a".repeat(64) } : {}), STATE: {
      get: async (key: string) => { reads.push(key); return { body: panel, httpEtag: JSON.stringify("tested-panel") }; },
    } as unknown as R2Bucket },
    names, requests, response, reads, ownerRequests,
  };
}

describe("public gateway dispatch", () => {
  it.each([
    ["/healthz", 200], ["/login", 200], ["/", 303], ["/logout", 303], ["/unknown", 404], ["/management.html", 303], ["/provider-panel.html", 401],
  ] as const)("handles %s without contacting or waking the Durable Object", async (path, status) => {
    const state = binding();
    const response = await worker.fetch(new Request(`https://gateway.example${path}`), state.env);
    expect(response.status).toBe(status);
    expect(state.names).toEqual([]);
    expect(state.requests).toEqual([]);
  });

  it.each(["/v1/messages", "/v8/management/config", "/callback", "/readyz", "/runtime/status"])("sends %s once to the preserved singleton", async (path) => {
    const state = binding();
    const request = new Request(`https://gateway.example${path}`);
    expect(await worker.fetch(request, state.env)).toBe(state.response);
    expect(state.names).toEqual(["cf-singleton-container"]);
    expect(state.requests).toEqual([request]);
  });

  it("routes an OAuth callback only to the Durable Object bound to its state", async () => {
    const state = binding("b".repeat(64));
    const request = new Request("https://gateway.example/callback?state=state-7&code=provider-code");
    const response = await worker.fetch(request, state.env, { access: { aud: "a".repeat(64) } } as ExecutionContext & { access: { aud: string } });
    expect(response.status).toBe(200);
    expect(state.names).toEqual(["cf-pool-coordinator-v1"]);
    expect(state.ownerRequests[0]?.url).toBe("https://gateway.example/callback?state=state-7&code=provider-code");
    expect(state.requests).toEqual([]);
  });

  it("fails closed for a callback with no persisted owner instead of guessing the singleton", async () => {
    const state = binding(undefined, true);
    const response = await worker.fetch(new Request("https://gateway.example/callback?state=unknown&code=x"), state.env,
      { access: { aud: "a".repeat(64) } } as ExecutionContext & { access: { aud: string } });
    expect(response.status).toBe(409);
    expect(state.names).toEqual(["cf-pool-coordinator-v1"]);
    expect(state.requests).toEqual([]);
    expect(state.ownerRequests).toEqual([]);
  });

  it.each(["/management.html", "/provider-panel.html"])("serves authenticated %s without touching the singleton", async (path) => {
    const state = binding();
    const cookie = `${SESSION_COOKIE}=${await issueSession(PASSWORD, Math.floor(Date.now() / 1000))}`;
    const response = await worker.fetch(new Request(`https://gateway.example${path}`, { headers: { cookie } }), state.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<html>tested provider panel</html>");
    expect(state.names).toEqual([]);
    expect(state.requests).toEqual([]);
    expect(state.reads).toEqual(["dashboard/management.html"]);
  });
});
