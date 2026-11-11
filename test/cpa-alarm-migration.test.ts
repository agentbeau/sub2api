import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { OAuthLease } from "../src/oauth-lease.ts";
import { BackgroundActivity, type BackgroundAction } from "../src/background-activity.ts";
import { LeaseStorage } from "./lease-storage.ts";

// Node does not provide Cloudflare's platform base classes. Keep the Cpa class, native
// lifecycle controller and gateway real; replace only the external platform boundary.
vi.mock("cloudflare:workers", () => {
  class PlatformEntrypoint<Environment> {
    constructor(protected readonly ctx: DurableObjectState, protected readonly env: Environment) {}
  }
  return { DurableObject: PlatformEntrypoint, WorkerEntrypoint: PlatformEntrypoint };
});
import { Cpa, R2Bridge } from "../src/cpa.ts";

function platform(running: boolean | undefined, deletion: Promise<void> = Promise.resolve(), leaseStorage = new LeaseStorage(), allowRequests = false) {
  const events: string[] = [];
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
          return new URL(request.url).pathname === "/__sub2api/lifecycle" ? Response.json({ activity_protocol: 1 }) : new Response("ok");
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
  const objectStore: Pick<R2Bucket, "head" | "get"> = { head: async () => null, get: async () => null };
  const cpa = new Cpa(context as DurableObjectState, { CONTAINER_IDLE_TIMEOUT_MS: "1000", STATE: objectStore } as Env);
  return {
    cpa,
    events,
    starts,
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
