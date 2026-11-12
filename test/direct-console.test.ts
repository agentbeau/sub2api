import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { LeaseStorage } from "./lease-storage.ts";
import { issueSession, SESSION_COOKIE } from "../worker/src/session.ts";

vi.mock("cloudflare:workers", () => {
  class PlatformEntrypoint<Environment> {
    constructor(protected readonly ctx: DurableObjectState, protected readonly env: Environment) {}
  }
  return { DurableObject: PlatformEntrypoint, WorkerEntrypoint: PlatformEntrypoint };
});
import { Cpa } from "../src/cpa.ts";

const PASSWORD = "direct-console-dashboard-0123456789abcdef";
const CLIENT_KEY = "direct-console-client-0123456789abcdef";
const ORIGIN = "https://api.agentbeau.dev";

async function headers(extra: Record<string, string> = {}) {
  return { cookie: `${SESSION_COOKIE}=${await issueSession(PASSWORD, Math.floor(Date.now() / 1000))}`, ...extra };
}

function fixture(nativeStatus = 200) {
  const storage = new LeaseStorage();
  const requests: Request[] = [];
  let running = false, starts = 0;
  let initialized: Promise<unknown> = Promise.resolve();
  const container = {
    get running() { return running; },
    start() { running = true; starts += 1; },
    async setInactivityTimeout() {},
    async interceptOutboundHttp() {},
    getTcpPort() { return {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = input instanceof Request && init === undefined ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/healthz") return new Response("ok");
        if (path === "/__sub2api/lifecycle") return Response.json({ activity_protocol: 1, frontend_auth_protocol: 1 });
        requests.push(request);
        return Response.json({ status: nativeStatus === 200 ? "ok" : "denied by native server" }, { status: nativeStatus });
      },
    }; },
  };
  const ctx = {
    container, exports: { R2Bridge: {} },
    storage: { get: <T>(key: string) => storage.get<T>(key), put: (key: string, value: unknown) => storage.put(key, value), delete: (key: string) => storage.delete(key), deleteAlarm: async () => {} },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => { const result = callback(); initialized = result; return result; },
  };
  const config = `config-version: 8\naccess:\n  api-keys: [${CLIENT_KEY}]\n`;
  const env = { DASHBOARD_PASSWORD: PASSWORD, CONTAINER_IDLE_TIMEOUT_MS: "1000", LOGIN_LIMIT: { limit: async () => ({ success: true }) }, STATE: {
    head: async (key: string) => key === "config/config.yaml" ? {} : null,
    get: async (key: string) => key === "config/config.yaml" ? { text: async () => config } : null,
  } };
  const app = new Cpa(ctx as unknown as DurableObjectState, env as unknown as Env);
  return { app, requests, ready: () => initialized, starts: () => starts, sleep: () => { running = false; } };
}

afterEach(() => vi.useRealTimers());

describe("direct console native forwarding", () => {
  it.each([{ authorization: "Bearer management-test-key" }, { "x-management-key": "management-test-key" }])("wakes for signed-in native management credentials without opening controls: %o", async (credential) => {
    const state = fixture();
    await state.ready();
    const response = await state.app.fetch(new Request(`${ORIGIN}/v8/management/config`, { headers: await headers(credential) }));
    expect(response.status).toBe(200);
    await response.text();
    expect(state.starts()).toBe(1);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.headers.has("cookie")).toBe(false);
    const status = await state.app.fetch(new Request(`${ORIGIN}/runtime/status`, { headers: await headers() }));
    expect(await status.json()).toMatchObject({ controls_remaining_ms: 0 });
  });

  it("reconnects after more than two minutes and native sleep without a separate start request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const state = fixture();
    await state.ready();
    const call = async () => state.app.fetch(new Request(`${ORIGIN}/v8/management/config`, { headers: await headers({ authorization: "Bearer management-test-key" }) }));
    expect(await (await call()).json()).toMatchObject({ status: "ok" });
    state.sleep();
    vi.setSystemTime(1_800_000_130_000);
    expect(await (await call()).json()).toMatchObject({ status: "ok" });
    expect(state.starts()).toBe(2);
    expect(state.requests.map(r => new URL(r.url).pathname)).toEqual(["/v8/management/config", "/v8/management/config"]);
  });

  it("leaves management-key validation to the native server and returns its rejection unchanged", async () => {
    const state = fixture(401);
    await state.ready();
    const response = await state.app.fetch(new Request(`${ORIGIN}/v8/management/config`, { headers: await headers({ authorization: "Bearer rejected-management-key" }) }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "denied by native server" });
    expect(state.starts()).toBe(1);
    expect(state.requests).toHaveLength(1);
  });

  it("does not start for an anonymous management credential, missing management credential or invalid client key", async () => {
    const state = fixture();
    await state.ready();
    expect((await state.app.fetch(new Request(`${ORIGIN}/v8/management/config`, { headers: { authorization: "Bearer management-test-key" } }))).status).toBe(401);
    expect((await state.app.fetch(new Request(`${ORIGIN}/v8/management/config`, { headers: await headers() }))).status).toBe(503);
    expect((await state.app.fetch(new Request(`${ORIGIN}/v1/responses`, { method: "POST", headers: await headers({ authorization: "Bearer invalid-client", referer: `${ORIGIN}/management.html` }), body: "{}" }))).status).toBe(401);
    expect(state.starts()).toBe(0);
    expect(state.requests).toHaveLength(0);
  });

  it("wakes for actual model calls from the console and preserves client headers and unread request body", async () => {
    const state = fixture();
    await state.ready();
    const response = await state.app.fetch(new Request(`${ORIGIN}/v1/responses`, {
      method: "POST", headers: await headers({ authorization: `Bearer ${CLIENT_KEY}`, referer: `${ORIGIN}/management.html`, "user-agent": "test-client/1", originator: "test-client", session_id: "session-test", "content-type": "application/json" }),
      body: '{"model":"gpt-5-codex","input":"test","stream":true}',
    }));
    expect(response.status).toBe(200);
    await response.text();
    expect(state.starts()).toBe(1);
    expect(state.requests).toHaveLength(1);
    const sent = state.requests[0];
    if (sent === undefined) throw new Error("Expected the native request");
    expect(sent.headers.get("cookie")).toBeNull();
    expect(sent.headers.get("user-agent")).toBe("test-client/1");
    expect(sent.headers.get("originator")).toBe("test-client");
    expect(sent.headers.get("session_id")).toBe("session-test");
    expect(sent.bodyUsed).toBe(false);
    expect(await sent.text()).toBe('{"model":"gpt-5-codex","input":"test","stream":true}');
  });
});
