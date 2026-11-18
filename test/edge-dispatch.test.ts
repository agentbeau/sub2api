import { describe, expect, it, vi } from "vitest";

// Cpa's platform class exports are not instantiated by this Worker entrypoint. The DO binding
// is the external boundary below; lifecycle behavior has its own controller/runtime coverage.
vi.mock("../src/cpa.ts", () => ({ Cpa: Symbol("Cpa"), R2Bridge: Symbol("R2Bridge") }));
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { issueSession, SESSION_COOKIE } from "../worker/src/session.ts";
import { sessionOwnerName } from "../src/session-routing.ts";

const PASSWORD = "long-dashboard-password-0123456789";

function binding(poolOwner?: string, poolEnabled = poolOwner !== undefined, sessionRouting = false) {
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
    fetchWithAccess: async (request: Request) => {
      requests.push(request);
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
      ...(poolEnabled ? { POOL_FENCING_ENABLED: "true", DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: "a".repeat(64) } : {}),
      ...(sessionRouting ? { POOL_SESSION_ROUTING_ENABLED: "true" } : {}), STATE: {
      get: async (key: string) => { reads.push(key); return { body: panel, httpEtag: JSON.stringify("tested-panel") }; },
    } as unknown as R2Bucket },
    names, requests, response, reads, ownerRequests,
  };
}

describe("public gateway dispatch", () => {
  it.each([
    ["runtime-session-repeat", "cf-singleton-container"],
    ["runtime-session-shard-0", "cf-session-owner-v1-2"],
    ["runtime-session-shard-1", "cf-session-owner-v1-1"],
  ])("keeps the v1 session-owner mapping stable for %s", (sessionId, owner) => {
    expect(sessionOwnerName(sessionId)).toBe(owner);
  });

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
    expect(await response.json()).toEqual({ error: {
      code: "oauth_owner_unknown", message: "The OAuth state is expired or unavailable. Start a new login flow.",
    } });
    expect(state.names).toEqual(["cf-pool-coordinator-v1"]);
    expect(state.requests).toEqual([]);
    expect(state.ownerRequests).toEqual([]);
  });

  it("routes an explicit JSON session to a stable named owner and preserves the original request body", async () => {
    const body = JSON.stringify({ model: "gpt-6.1-sol", session_id: "project-chat-17", messages: [{ role: "user", content: "hello" }] });
    const state = binding(undefined, false, true);
    const request = new Request("https://gateway.example/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    await worker.fetch(request, state.env);
    expect(state.names).toEqual([sessionOwnerName("project-chat-17")]);
    expect(await state.requests[0]?.text()).toBe(body);
  });

  it("routes repeated explicit headers consistently and honors the CPA Claude-session precedence", async () => {
    const state = binding(undefined, false, true);
    const request = new Request("https://gateway.example/v1/messages", {
      method: "POST", headers: {
        "content-type": "application/json", "x-claude-code-session-id": "claude-root-1", "x-session-id": "other-session",
      }, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    await worker.fetch(request, state.env);
    await worker.fetch(new Request(request.url, { method: "POST", headers: { "x-claude-code-session-id": "claude-root-1" }, body: "{}" }), state.env);
    expect(state.names).toEqual([sessionOwnerName("claude-root-1"), sessionOwnerName("claude-root-1")]);
  });

  it("uses only an explicit Claude session inside user_id metadata and ignores ordinary user IDs", async () => {
    const state = binding(undefined, false, true);
    const userMetadata = new Request("https://gateway.example/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { user_id: "account-42" }, messages: [{ role: "user", content: "session_id: hidden in prompt" }] }),
    });
    await worker.fetch(userMetadata, state.env);
    expect(state.names[0]).toBe("cf-singleton-container");

    const session = "7d6eaa61-9aa3-42e8-9261-ef41a2c0063a";
    await worker.fetch(new Request(userMetadata.url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { user_id: `claude-user_session_${session}` }, messages: [] }),
    }), state.env);
    expect(state.names[1]).toBe(sessionOwnerName(session));
  });

  it("keeps requests with no explicit session on the legacy singleton, including Responses continuations", async () => {
    const state = binding(undefined, false, true);
    for (const body of [
      JSON.stringify({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "hello" }] }),
      JSON.stringify({ model: "gpt-6.1-sol", previous_response_id: "resp_existing_7", input: "continue" }),
    ]) {
      await worker.fetch(new Request("https://gateway.example/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }), state.env);
    }
    expect(state.names).toEqual(["cf-singleton-container", "cf-singleton-container"]);
  });

  it("does not parse oversized bodies to choose an owner and leaves the upload intact", async () => {
    const filler = "x".repeat(300 * 1024);
    const body = JSON.stringify({ messages: [{ role: "user", content: filler }], session_id: "too-large-to-inspect" });
    const state = binding(undefined, false, true);
    await worker.fetch(new Request("https://gateway.example/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }), state.env);
    expect(state.names).toEqual(["cf-singleton-container"]);
    expect(await state.requests[0]?.text()).toBe(body);
  });

  it("keeps authenticated dashboard and OAuth ingress on the singleton despite session hints", async () => {
    const state = binding("b".repeat(64), true, true);
    const request = new Request("https://gateway.example/v8/management/oauth/auth-url", {
      method: "POST", headers: { "content-type": "application/json", "x-session-id": "irrelevant" }, body: JSON.stringify({ provider: "codex" }),
    });
    await worker.fetch(request, state.env, { access: { aud: "a".repeat(64) } } as ExecutionContext & { access: { aud: string } });
    expect(state.names).toEqual(["cf-singleton-container"]);
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
