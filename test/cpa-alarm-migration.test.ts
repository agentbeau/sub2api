import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { OAuthLease } from "../src/oauth-lease.ts";
import { BackgroundActivity, type BackgroundAction } from "../src/background-activity.ts";
import { LeaseStorage } from "./lease-storage.ts";
import { ManagementWindow } from "../src/management-window.ts";
import { RealtimeLease } from "../src/realtime-lease.ts";
import { issueSession, SESSION_COOKIE } from "../worker/src/session.ts";

const DASHBOARD_PASSWORD = "native-wake-dashboard-0123456789abcdef";
const CLIENT_KEY = "native-wake-client-0123456789abcdef";

async function signedHeaders(origin = "https://gateway.example"): Promise<HeadersInit> {
  return { cookie: `${SESSION_COOKIE}=${await issueSession(DASHBOARD_PASSWORD, Math.floor(Date.now() / 1000))}`, origin };
}

// Node does not provide Cloudflare's platform base classes. Keep the Cpa class, native
// lifecycle controller and gateway real; replace only the external platform boundary.
vi.mock("cloudflare:workers", () => {
  class PlatformEntrypoint<Environment> {
    constructor(protected readonly ctx: DurableObjectState, protected readonly env: Environment) {}
  }
  return { DurableObject: PlatformEntrypoint, WorkerEntrypoint: PlatformEntrypoint };
});
import { Cpa, R2Bridge } from "../src/cpa.ts";

function platform(running: boolean | undefined, deletion: Promise<void> = Promise.resolve(), leaseStorage = new LeaseStorage(), allowRequests = false, configuration: string | null = null, provider?: (request: Request) => Promise<Response>, capability?: () => Response | Promise<Response>) {
  const events: string[] = [];
  const requests: Request[] = [];
  const starts: ContainerStartupOptions[] = [];
  let isRunning = running ?? false;
  let persistedAlarm: number | null = Date.now() + 60_000;
  let initialization: Promise<unknown> = Promise.resolve();
  const container: Pick<Container, "running" | "start" | "getTcpPort" | "interceptOutboundHttp" | "setInactivityTimeout"> = {
    get running() { return isRunning; },
    start: (options) => {
      if (!allowRequests) throw new Error("Migrating alarms must not start a container");
      if (options !== undefined) starts.push(options);
      events.push("start");
      isRunning = true;
    },
    getTcpPort: () => {
      if (!allowRequests) throw new Error("Migrating alarms must not poll a container");
      return {
        fetch: async (input, init) => {
          events.push("port_fetch");
          const request = input instanceof Request && init === undefined ? input : new Request(input, init);
          requests.push(request);
          const path = new URL(request.url).pathname;
          if (path === "/__sub2api/lifecycle") return capability?.() ?? Response.json({ activity_protocol: 1, frontend_auth_protocol: 1, initialization_protocol: 1, initialization_ready: true });
          if (path === "/healthz") return new Response("ok");
          return provider?.(request) ?? new Response("ok");
        },
        connect: () => { throw new Error("HTTP readiness must not open raw TCP"); },
      };
    },
    interceptOutboundHttp: async () => { events.push("restore_interception"); },
    setInactivityTimeout: async (timeout: number | bigint) => { events.push(`restore_timeout:${timeout}`); },
  };
  const context = {
    ...(running === undefined ? {} : { container }),
    storage: {
      get: <T>(key: string) => leaseStorage.get<T>(key),
      put: (key: string, value: unknown) => leaseStorage.put(key, value),
      delete: (key: string) => leaseStorage.delete(key),
      deleteAlarm: async () => {
        events.push("delete_alarm");
        await deletion;
        persistedAlarm = null;
        events.push("alarm_deleted");
      },
    },
    exports: { R2Bridge: {} },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => {
      const pending = callback();
      initialization = pending;
      return pending;
    },
  };
  // The external context exposes only the APIs this production constructor can use. Any
  // unexpected storage, network or alarm scheduling operation fails instead of being faked.
  const objectStore = {
    head: async (key: string) => key === "config/config.yaml" && configuration !== null ? {} : null,
    get: async (key: string) => key === "config/config.yaml" && configuration !== null ? { text: async () => configuration } : null,
  };
  const cpa = new Cpa(context as DurableObjectState, {
    CONTAINER_IDLE_TIMEOUT_MS: "1000", STATE: objectStore, DASHBOARD_PASSWORD,
    LOGIN_LIMIT: { limit: async () => ({ success: true }) },
  } as unknown as Env);
  return {
    cpa,
    events,
    starts,
    requests,
    initialized: () => initialization,
    getAlarm: () => persistedAlarm,
    queueLegacyAlarm: () => { persistedAlarm = Date.now() + 1; },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("legacy Container helper alarm migration", () => {
  it.each([false, undefined])("removes a persisted helper alarm when container.running is %s without starting CPA", async (running) => {
    const state = platform(running);
    await state.initialized();
    expect(state.getAlarm()).toBeNull();
    expect(state.events).toEqual(["delete_alarm", "alarm_deleted"]);
  });

  it("loads persisted activity before restoring native idle after object eviction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    const lease = new OAuthLease(storage);
    await lease.observe(new Request("https://gateway.example/v8/management/oauth/auth-url", {
      headers: { authorization: "Bearer accepted-management-key" },
    }), Response.json({ status: "ok", state: "persisted-state", expires_in: 1800, url: "https://provider.example/authorize" }));
    vi.setSystemTime(1_020_000);
    const state = platform(true, Promise.resolve(), storage);
    await state.initialized();
    expect(state.events).toEqual(["delete_alarm", "alarm_deleted", "restore_interception", "restore_timeout:1840000"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes removing a persisted alarm before restoring a running container", async () => {
    let finishDeletion: () => void = () => {};
    const deletion = new Promise<void>((resolve) => { finishDeletion = resolve; });
    const state = platform(true, deletion);
    expect(state.events).toEqual(["delete_alarm"]);
    finishDeletion();
    await state.initialized();
    expect(state.getAlarm()).toBeNull();
    expect(state.events).toEqual(["delete_alarm", "alarm_deleted", "restore_interception", "restore_timeout:1800000"]);
  });

  it("accepts an already queued legacy alarm without starting, polling or rescheduling CPA", async () => {
    const state = platform(false);
    await state.initialized();
    state.events.length = 0;
    state.queueLegacyAlarm();
    expect(state.cpa.alarm).toBeTypeOf("function");
    await state.cpa.alarm();
    expect(state.getAlarm()).toBeNull();
    expect(state.events).toEqual(["delete_alarm", "alarm_deleted"]);
  });
});

describe("dashboard and API wake admission", () => {
  const configuration = `config-version: 8\naccess:\n  api-keys: [${CLIENT_KEY}]\n`;

  it.each(["/v1/models", "/v8/management/config"])("uses neutral forwarded %s headers without changing provider content", async (path) => {
    const upstream = new Response('{"client_version":"cpa"}', { headers: {
      "X-CPA-VERSION": "v8.0.67", "access-control-expose-headers": "X-CPA-VERSION, ETag",
    } });
    const state = platform(true, Promise.resolve(), new LeaseStorage(), true, configuration, async () => upstream);
    await state.initialized();
    const headers = new Headers(await signedHeaders());
    headers.set("x-api-key", CLIENT_KEY);
    const response = await state.cpa.fetch(new Request(`https://gateway.example${path}`, { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-cpa-version")).toBeNull();
    expect(response.headers.get("x-sub2api-engine-version")).toBeNull();
    expect(response.headers.get("x-engine-version")).toBe(path.startsWith("/v1/") ? null : "v8.0.67");
    expect(response.headers.get("access-control-expose-headers")).toBe(path.startsWith("/v1/") ? "ETag" : "x-engine-version, ETag");
    expect(response.body).toBe(upstream.body);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('{"client_version":"cpa"}');
    expect(state.starts).toHaveLength(0);
    expect(state.requests.filter((request) => new URL(request.url).pathname === path)).toHaveLength(1);
  });

  it.each(["/runtime/status", "/v8/management/config", "/callback?state=expired&code=invalid"])("authenticated %s never starts a stopped provider", async (path) => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const response = await state.cpa.fetch(new Request(`https://gateway.example${path}`, { headers: await signedHeaders() }));
    expect(response.status).toBe(path === "/runtime/status" ? 200 : 503);
    expect(state.starts).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
  });

  it.each([
    "https://gateway.example/provider-panel.html",
    "https://gateway.example/management.html",
    "https://gateway.example:443/provider-panel.html?view=models#system-info",
  ])("does not wake for a valid-key model catalog request from %s", async (referer) => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const headers = new Headers(await signedHeaders());
    headers.set("authorization", `Bearer ${CLIENT_KEY}`);
    headers.set("referer", referer);
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/models", { headers }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "runtime_asleep" } });
    expect(state.starts).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
  });

  it.each([
    "https://other.example/provider-panel.html",
    "https://gateway.example@other.example/management.html",
    "http://gateway.example/management.html",
    "https://gateway.example:8443/provider-panel.html",
    "https://gateway.example/provider-panel.html.backup",
    "https://gateway.example/client.html",
    "not an absolute URL",
  ])("preserves native API wake for a non-panel referer %s", async (referer) => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/models", {
      headers: { authorization: `Bearer ${CLIENT_KEY}`, referer },
    }));
    expect(response.status).toBe(200);
    expect(state.starts).toHaveLength(1);
    expect(state.requests.filter((request) => new URL(request.url).pathname === "/v1/models")).toHaveLength(1);
  });

  it("forwards an authenticated panel API body once to an existing process without reading it", async () => {
    const state = platform(true, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const headers = new Headers(await signedHeaders());
    headers.set("authorization", `Bearer ${CLIENT_KEY}`);
    headers.set("referer", "https://gateway.example/provider-panel.html");
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/messages", {
      method: "POST", headers, body: '{"model":"provider-model","messages":[]}',
    }));
    expect(response.status).toBe(200);
    expect(state.starts).toHaveLength(0);
    const forwarded = state.requests.filter((request) => new URL(request.url).pathname === "/v1/messages");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.bodyUsed).toBe(false);
    expect(await forwarded[0]?.text()).toBe('{"model":"provider-model","messages":[]}');
  });

  it("does not treat a panel referer or signed-in session as API authentication", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const headers = new Headers(await signedHeaders());
    headers.set("authorization", "Bearer invalid-key");
    headers.set("referer", "https://gateway.example/provider-panel.html");
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/models", { headers }));
    expect(response.status).toBe(401);
    expect(state.starts).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
  });

  it.each([
    ["/v1/models", undefined, 401], ["/v1/models", "wrong-key", 401], ["/v1/not-an-api", CLIENT_KEY, 404],
  ] as const)("rejects %s (%s) before any provider operation", async (path, key, status) => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const response = await state.cpa.fetch(new Request(`https://gateway.example${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }));
    expect(response.status).toBe(status);
    expect(state.starts).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
  });

  it("still wakes natively for a valid client key and forwards its request once", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/messages", {
      method: "POST", headers: { authorization: `Bearer ${CLIENT_KEY}` }, body: '{"model":"provider-model"}',
    }));
    expect(response.status).toBe(200);
    expect(state.starts).toHaveLength(1);
    const model = state.requests.filter((request) => new URL(request.url).pathname === "/v1/messages");
    expect(model).toHaveLength(1);
    expect(await model[0]?.text()).toBe('{"model":"provider-model"}');
    expect(state.events.at(-1)).toBe("port_fetch");
  });

  it("preserves native wake when an enabled plugin must decide authentication", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true,
      "config-version: 8\nplugins:\n  enabled: true\n  configs:\n    frontend-auth:\n      enabled: true\n");
    await state.initialized();
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/models", { headers: { authorization: "plugin-credential" } }))).status).toBe(200);
    expect(state.starts).toHaveLength(1);
  });

  it("requires a signed-in, same-origin POST before an explicit start", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true);
    await state.initialized();
    const request = (method: string, headers?: HeadersInit) => new Request("https://gateway.example/runtime/start", { method, ...(headers ? { headers } : {}) });
    expect((await state.cpa.fetch(request("POST"))).status).toBe(401);
    expect((await state.cpa.fetch(request("GET", await signedHeaders()))).status).toBe(405);
    expect((await state.cpa.fetch(request("POST", await signedHeaders("https://untrusted.example")))).status).toBe(403);
    expect(state.starts).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
    const started = await state.cpa.fetch(request("POST", await signedHeaders()));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ running: true, controls_remaining_ms: expect.any(Number) });
    expect(state.starts).toHaveLength(1);
  });

  it("does not slide the editing deadline on status polls and closing leaves actual work protected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    const state = platform(false, Promise.resolve(), storage, true);
    await state.initialized();
    const headers = await signedHeaders();
    await state.cpa.fetch(new Request("https://gateway.example/runtime/start", { method: "POST", headers }));
    expect(state.events.at(-1)).toBe("restore_timeout:120000");
    vi.setSystemTime(1_020_000);
    const status = await state.cpa.fetch(new Request("https://gateway.example/runtime/status", { headers }));
    expect(await status.json()).toMatchObject({ running: true, controls_remaining_ms: 100_000 });
    expect(state.events.at(-1)).toBe("restore_timeout:100000");
    expect(await state.cpa.backgroundActivity("begin", "a".repeat(32))).toBe(true);
    const closed = await state.cpa.fetch(new Request("https://gateway.example/runtime/stop", { method: "POST", headers }));
    expect(await closed.json()).toMatchObject({ running: true, controls_remaining_ms: 0 });
    expect(state.events.at(-1)).toBe("restore_timeout:90000");
    expect(state.starts).toHaveLength(1);
    const window = new ManagementWindow(storage);
    await window.restore();
    expect(window.remainingMs()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("mixed provider image authentication", () => {
  const configuration = `config-version: 8\naccess:\n  api-keys: [${CLIENT_KEY}]\n`;

  it.each([
    { label: "a stale saved key", path: "/v1/messages", method: "POST", key: CLIENT_KEY, running: true, configuration },
    { label: "a warm temporary credential", path: "/v1/realtime", method: "GET", key: "ek_existing-secret", running: true, configuration },
    { label: "a native plugin credential", path: "/v1/messages", method: "POST", key: "plugin-credential", running: false,
      configuration: "config-version: 8\nplugins:\n  enabled: true\n  configs:\n    frontend-auth:\n      enabled: true\n" },
  ])("does not forward $label to an activity-only image", async (testCase) => {
    const state = platform(testCase.running, Promise.resolve(), new LeaseStorage(), true, testCase.configuration,
      async () => new Response("old engine would accept any credential"), () => Response.json({ activity_protocol: 1, initialization_protocol: 1, initialization_ready: true }));
    await state.initialized();
    const response = await state.cpa.fetch(new Request(`https://gateway.example${testCase.path}`, {
      method: testCase.method, headers: { authorization: `Bearer ${testCase.key}` },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "runtime_upgrade_required" } });
    expect(state.requests.some((request) => new URL(request.url).pathname === testCase.path)).toBe(false);
    expect(state.starts).toHaveLength(testCase.running ? 0 : 1);
  });

  it("retains native readiness, management and explicit controls while an old image is being replaced", async () => {
    const state = platform(true, Promise.resolve(), new LeaseStorage(), true, configuration, undefined,
      () => Response.json({ activity_protocol: 1, initialization_protocol: 1, initialization_ready: true }));
    await state.initialized();
    expect((await state.cpa.fetch(new Request("https://gateway.example/readyz"))).status).toBe(200);
    expect((await state.cpa.fetch(new Request("https://gateway.example/v8/management/config", { headers: await signedHeaders() }))).status).toBe(200);
    expect((await state.cpa.fetch(new Request("https://gateway.example/runtime/start", { method: "POST", headers: await signedHeaders() }))).status).toBe(200);
    expect(state.starts).toHaveLength(0);
  });
});

describe("actual background work and native inactivity", () => {
  const firstId = "a".repeat(32);
  const secondId = "b".repeat(32);

  it("configures the internal activity endpoint when starting a fresh process", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true);
    await state.initialized();
    expect((await state.cpa.fetch(new Request("https://gateway.example/readyz"))).status).toBe(200);
    expect(state.starts[0]?.env?.SUB2API_ACTIVITY_ENDPOINT).toBe("http://r2.internal/__sub2api/activity");
  });

  it("restores running jobs and keeps the maximum of background and OAuth deadlines", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    await new BackgroundActivity(storage).update("begin", firstId);
    const oauth = new OAuthLease(storage);
    await oauth.observe(new Request("https://gateway.example/v8/management/oauth/auth-url", {
      headers: { authorization: "Bearer accepted-management-key" },
    }), Response.json({ status: "ok", state: "oauth-state", expires_in: 120 }));
    vi.setSystemTime(1_020_000);
    const state = platform(true, Promise.resolve(), storage, true);
    await state.initialized();
    expect(state.events.at(-1)).toBe("restore_timeout:1800000");
    await state.cpa.fetch(new Request("https://gateway.example/readyz"));
    const lastTimeout = () => state.events.filter((event) => event.startsWith("restore_timeout:")).at(-1);
    expect(lastTimeout()).toBe("restore_timeout:160000");
    expect(state.cpa.backgroundActivity).toBeTypeOf("function");
    expect(await state.cpa.backgroundActivity("renew", firstId)).toBe(true);
    expect(lastTimeout()).toBe("restore_timeout:160000");
    vi.setSystemTime(1_100_000);
    expect(await state.cpa.backgroundActivity("begin", secondId)).toBe(true);
    expect(lastTimeout()).toBe("restore_timeout:90000");
    expect(await state.cpa.backgroundActivity("end", secondId)).toBe(true);
    expect(lastTimeout()).toBe("restore_timeout:80000");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses background activity for a stopped container without waking it", async () => {
    const storage = new LeaseStorage();
    const state = platform(false, Promise.resolve(), storage);
    await state.initialized();
    expect(state.cpa.backgroundActivity).toBeTypeOf("function");
    expect(await state.cpa.backgroundActivity("begin", firstId)).toBe(false);
    expect(state.events).toEqual(["delete_alarm", "alarm_deleted"]);
    const restored = new BackgroundActivity(storage);
    await restored.restore();
    expect(restored.remainingMs()).toBe(0);
  });

  it("returns to short idle after a restored job renews and ends without any public request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    await new BackgroundActivity(storage).update("begin", firstId);
    vi.setSystemTime(1_030_000);
    const state = platform(true, Promise.resolve(), storage, true);
    await state.initialized();
    expect(state.events.at(-1)).toBe("restore_timeout:1800000");
    expect(await state.cpa.backgroundActivity("renew", firstId)).toBe(true);
    expect(state.events.at(-1)).toBe("restore_timeout:90000");
    vi.setSystemTime(1_040_000);
    expect(await state.cpa.backgroundActivity("end", firstId)).toBe(true);
    expect(state.events.at(-1)).toBe("restore_timeout:1000");
    expect(state.starts).toHaveLength(0);
    expect(state.events.filter((event) => event === "port_fetch")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears prior-process OAuth and background holds only when forwarding starts a new process", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    await new BackgroundActivity(storage).update("begin", firstId);
    const oauth = new OAuthLease(storage);
    await oauth.observe(new Request("https://gateway.example/v8/management/oauth/auth-url", {
      headers: { authorization: "Bearer accepted-management-key" },
    }), Response.json({ status: "ok", state: "lost-process-state", expires_in: 1800 }));
    await oauth.observe(new Request("https://gateway.example/v8/management/config", {
      method: "PATCH", headers: { authorization: "Bearer accepted-management-key" },
    }), Response.json({ status: "ok" }));
    const state = platform(false, Promise.resolve(), storage, true);
    await state.initialized();
    const before = new BackgroundActivity(storage);
    await before.restore();
    expect(before.remainingMs()).toBe(90_000);
    const oauthBefore = new OAuthLease(storage);
    await oauthBefore.restore();
    expect(oauthBefore.remainingMs()).toBe(1_860_000);
    expect(state.events).toEqual(["delete_alarm", "alarm_deleted"]);
    expect((await state.cpa.fetch(new Request("https://gateway.example/readyz"))).status).toBe(200);
    expect(state.events.filter((event) => event.startsWith("restore_timeout:"))).toEqual(["restore_timeout:1800000", "restore_timeout:1000"]);
    const after = new BackgroundActivity(storage);
    await after.restore();
    expect(after.remainingMs()).toBe(0);
    const oauthAfter = new OAuthLease(storage);
    await oauthAfter.restore();
    expect(oauthAfter.remainingMs()).toBe(0);
    expect(state.events.filter((event) => event === "start")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispatches internal activity to the same typed Cpa singleton through R2Bridge", async () => {
    const calls: Array<{ name: string; action: BackgroundAction; id: string }> = [];
    const env = {
      CPA: {
        getByName: (name: string) => ({ backgroundActivity: async (action: BackgroundAction, id: string) => {
          calls.push({ name, action, id });
          return true;
        } }),
      },
    };
    const bridge = new R2Bridge({} as ExecutionContext, env as Env);
    const response = await bridge.fetch(new Request("http://r2.internal/__sub2api/activity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "begin", id: firstId }),
    }));
    expect(response.status).toBe(204);
    expect(calls).toEqual([{ name: "cf-singleton-container", action: "begin", id: firstId }]);
  });
});

describe("native realtime credential lifetime", () => {
  const configuration = `config-version: 8\naccess:\n  api-keys: [${CLIENT_KEY}]\n`;
  const authorization = { authorization: `Bearer ${CLIENT_KEY}` };
  const lastTimeout = (events: string[]) => events.filter((event) => event.startsWith("restore_timeout:")).at(-1);

  it("holds successful issuance through idle gaps and reusable native access until absolute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const minted = Response.json({ value: "ek_live-native-credential", expires_at: 1600, session: { type: "realtime" } });
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration, async (request) =>
      new URL(request.url).pathname === "/v1/realtime/client_secrets" ? minted : new Response("connected"));
    await state.initialized();
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/realtime/client_secrets", { method: "POST", headers: authorization }));
    expect(response).toBe(minted);
    expect(response.bodyUsed).toBe(false);
    expect(lastTimeout(state.events)).toBe("restore_timeout:601000");
    expect(state.starts).toHaveLength(1);

    vi.setSystemTime(1_005_000);
    const ephemeral = { authorization: "Bearer ek_live-native-credential" };
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/realtime", { headers: ephemeral }))).status).toBe(200);
    expect(lastTimeout(state.events)).toBe("restore_timeout:596000");
    vi.setSystemTime(1_010_000);
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/realtime/calls/call-one/hangup", { method: "POST", headers: authorization }))).status).toBe(200);
    expect(lastTimeout(state.events)).toBe("restore_timeout:591000");
    vi.setSystemTime(1_015_000);
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/realtime", { headers: ephemeral }))).status).toBe(200);
    expect(lastTimeout(state.events)).toBe("restore_timeout:586000");
    vi.setSystemTime(1_601_000);
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/models", { headers: authorization }))).status).toBe(200);
    expect(lastTimeout(state.events)).toBe("restore_timeout:1000");
    expect(state.starts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores the remaining credential lifetime before reattaching a running process", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    const lease = new RealtimeLease(storage);
    await lease.observe(new Request("https://gateway.example/v1/realtime/client_secrets", { method: "POST", headers: authorization }),
      Response.json({ value: "ek_restored-credential", expires_at: 8200 }));
    vi.setSystemTime(1_020_000);
    const state = platform(true, Promise.resolve(), storage, true, configuration);
    await state.initialized();
    expect(lastTimeout(state.events)).toBe("restore_timeout:7181000");
    expect(state.requests).toHaveLength(0);
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/models", { headers: authorization }))).status).toBe(200);
    expect(lastTimeout(state.events)).toBe("restore_timeout:7181000");
    expect(state.starts).toHaveLength(0);
  });

  it("clears the old process's credential hold only when an admitted request starts its replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    await new RealtimeLease(storage).observe(new Request("https://gateway.example/v1/realtime/client_secrets", { method: "POST", headers: authorization }),
      Response.json({ value: "ek_lost-process", expires_at: 1600 }));
    const state = platform(false, Promise.resolve(), storage, true, configuration);
    await state.initialized();
    const before = new RealtimeLease(storage);
    await before.restore();
    expect(before.remainingMs()).toBe(601_000);
    expect(state.starts).toHaveLength(0);
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/messages", { method: "POST", headers: authorization, body: "admitted model request" }))).status).toBe(200);
    const after = new RealtimeLease(storage);
    await after.restore();
    expect(after.remainingMs()).toBe(0);
    expect(lastTimeout(state.events)).toBe("restore_timeout:1000");
    expect(state.starts).toHaveLength(1);
  });

  it("keeps ordinary inference streaming unchanged while the additional hold is installed", async () => {
    let pulls = 0;
    const upstream = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode("data: model output\n\n"));
      controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    const clone = vi.spyOn(upstream, "clone");
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration, async () => upstream);
    await state.initialized();
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/messages", { method: "POST", headers: authorization, body: "stream inference" }));
    expect(response).toBe(upstream);
    expect(clone).not.toHaveBeenCalled();
    expect(pulls).toBe(0);
    expect(lastTimeout(state.events)).toBe("restore_timeout:1000");
    expect(await response.text()).toBe("data: model output\n\n");
  });
});
