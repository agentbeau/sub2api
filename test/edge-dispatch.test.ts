import { describe, expect, it, vi } from "vitest";

// Cpa's platform class exports are not instantiated by this Worker entrypoint. The DO binding
// is the external boundary below; lifecycle behavior has its own controller/runtime coverage.
vi.mock("../src/cpa.ts", () => ({ Cpa: Symbol("Cpa"), R2Bridge: Symbol("R2Bridge") }));
import worker from "../src/index.ts";
import { issueSession, SESSION_COOKIE } from "../worker/src/session.ts";

const PASSWORD = "long-dashboard-password-0123456789";

function binding() {
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
  const namespace: DurableObjectNamespace = {
    newUniqueId: () => { throw new Error("Must preserve the singleton"); },
    idFromName: () => { throw new Error("Use the existing named object"); },
    idFromString: () => { throw new Error("Must preserve the singleton"); },
    get: () => { throw new Error("Use getByName"); },
    getByName: (name) => { names.push(name); return stub; },
    jurisdiction: () => { throw new Error("Must preserve existing placement"); },
  };
  return {
    env: { CPA: namespace, DASHBOARD_PASSWORD: PASSWORD, LOGIN_LIMIT: { limit: async () => ({ success: true }) }, STATE: {
      get: async (key: string) => { reads.push(key); return { body: panel, httpEtag: JSON.stringify("tested-panel") }; },
    } as unknown as R2Bucket },
    names, requests, response, reads,
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
