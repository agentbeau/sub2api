import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { OAuthLease } from "../src/oauth-lease.ts";
import { BackgroundActivity, type BackgroundAction } from "../src/background-activity.ts";
import { LeaseStorage } from "./lease-storage.ts";
import { ManagementWindow } from "../src/management-window.ts";
import { RealtimeLease } from "../src/realtime-lease.ts";
import type { FencedLease } from "../src/pool-coordination.ts";
import { MemoryStore } from "./memory-store.ts";
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

function platform(running: boolean | undefined, deletion: Promise<void> = Promise.resolve(), leaseStorage = new LeaseStorage(), allowRequests = false, configuration: string | null = null, provider?: (request: Request) => Promise<Response>, capability?: () => Response | Promise<Response>, cloudflareAccess = false, stateBinding?: R2Bucket) {
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
          return provider?.(request) ?? new Response(null);
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
      transaction: <T>(callback: (txn: {
        get<T>(key: string): Promise<T | undefined>;
        put<T>(key: string, value: T): Promise<void>;
        delete(key: string): Promise<boolean>;
      }) => Promise<T>) => leaseStorage.transaction(callback),
      deleteAlarm: async () => {
        events.push("delete_alarm");
        await deletion;
        persistedAlarm = null;
        events.push("alarm_deleted");
      },
    },
    id: { toString: () => "a".repeat(64) },
    exports: { R2Bridge: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
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
  const poolLeases = new Map<string, FencedLease>();
  const oauthOwners = new Map<string, string>();
  const coordinator = {
    claimPoolRefresh: async (resource: string, owner: string, leaseMs: number) => {
      const current = poolLeases.get(resource);
      if (current !== undefined && current.expiresAt > Date.now()) return undefined;
      const lease = { resource, owner, epoch: (current?.epoch ?? 0) + 1, expiresAt: Date.now() + leaseMs } satisfies FencedLease;
      poolLeases.set(resource, lease);
      return lease;
    },
    renewPoolRefresh: async (lease: FencedLease, leaseMs: number) => {
      const current = poolLeases.get(lease.resource);
      if (current?.owner !== lease.owner || current.epoch !== lease.epoch || current.expiresAt <= Date.now()) return undefined;
      const renewed = { ...current, expiresAt: Date.now() + leaseMs };
      poolLeases.set(lease.resource, renewed);
      return renewed;
    },
    releasePoolRefresh: async (lease: FencedLease) => {
      const current = poolLeases.get(lease.resource);
      if (current?.owner !== lease.owner || current.epoch !== lease.epoch) return false;
      poolLeases.set(lease.resource, { ...current, owner: "", expiresAt: Date.now() });
      return true;
    },
    validatePoolFence: async (resource: string, owner: string, epoch: number) => {
      const current = poolLeases.get(resource);
      return current?.owner === owner && current.epoch === epoch && current.expiresAt > Date.now();
    },
    bindPoolOAuthOwner: async (state: string, owner: string) => {
      const current = oauthOwners.get(state);
      if (current !== undefined && current !== owner) return false;
      oauthOwners.set(state, owner);
      return true;
    },
    releasePoolOAuthOwner: async (state: string, owner: string) => {
      events.push("release_oauth_owner");
      if (oauthOwners.get(state) !== owner) return false;
      oauthOwners.delete(state);
      return true;
    },
    poolOAuthOwner: async (state: string) => oauthOwners.get(state),
  };
  const cpa = new Cpa(context as unknown as DurableObjectState, {
    CONTAINER_IDLE_TIMEOUT_MS: "1000", STATE: stateBinding ?? objectStore as unknown as R2Bucket, DASHBOARD_PASSWORD,
    ...(cloudflareAccess ? { DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: "a".repeat(64) } : {}),
    LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    CPA: { getByName: () => coordinator } as unknown as Env["CPA"],
  } as unknown as Env);
  return {
    cpa,
    events,
    starts,
    requests,
    poolLeases,
    oauthOwners,
    initialized: () => initialization,
    getAlarm: () => persistedAlarm,
    queueLegacyAlarm: () => { persistedAlarm = Date.now() + 1; },
    stop: () => { isRunning = false; },
  };
}

describe("integrated pool ownership hooks", () => {
  it("leases an actual background refresh resource, rejects reentry, then releases it", async () => {
    const state = platform(true, Promise.resolve(), new LeaseStorage(), true);
    await state.initialized();
    const activity = "e".repeat(32);
    const first = await state.cpa.fencedBackgroundActivity("begin", activity, "refresh-credential-9");
    expect(first).toMatchObject({ resource: "refresh-credential-9", owner: "a".repeat(64) + ":" + activity, epoch: 1 });
    expect(await state.cpa.fencedBackgroundActivity("begin", "f".repeat(32), "refresh-credential-9")).toBeUndefined();
    expect(await state.cpa.fencedBackgroundActivity("renew", activity, "refresh-credential-9")).toMatchObject({ epoch: 1 });
    expect(await state.cpa.fencedBackgroundActivity("end", activity, "refresh-credential-9")).toBe(true);
    expect(await state.cpa.fencedBackgroundActivity("begin", "f".repeat(32), "refresh-credential-9")).toMatchObject({ epoch: 2 });
  });

  it("rejects lease renewal after expiry and refuses an old owner's resumption", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const state = platform(true, Promise.resolve(), new LeaseStorage(), true);
    await state.initialized();
    const resource = "refresh-credential-expiry";
    const oldId = "1".repeat(32);
    const old = await state.cpa.fencedBackgroundActivity("begin", oldId, resource);
    if (old === undefined || typeof old === "boolean") throw new Error("Expected initial lease");
    vi.setSystemTime(2_091_000);
    expect(await state.cpa.fencedBackgroundActivity("renew", oldId, resource)).toBeUndefined();
    const replacement = await state.cpa.fencedBackgroundActivity("begin", "2".repeat(32), resource);
    if (replacement === undefined || typeof replacement === "boolean") throw new Error("Expected takeover lease");
    expect(replacement.epoch).toBe(old.epoch + 1);
    expect(await state.cpa.fencedBackgroundActivity("renew", oldId, resource)).toBeUndefined();
    vi.useRealTimers();
  });

  it("binds OAuth state to the Durable Object that starts the upstream session", async () => {
    const state = platform(true, Promise.resolve(), new LeaseStorage(), true, null,
      async () => Response.json({ status: "ok", state: "oauth-state-affinity", expires_in: 120 }), undefined, true);
    await state.initialized();
    const response = await state.cpa.fetchWithAccess(new Request("https://gateway.example/v8/management/oauth/auth-url?provider=codex", {
      headers: { "x-management-key": "synthetic-management-key" },
    }));
    expect(response.status).toBe(200);
    expect(state.oauthOwners.get("oauth-state-affinity")).toBe("a".repeat(64));
  });

  it("invalidates a process-local PKCE callback binding before cold restart", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, null,
      async () => Response.json({ status: "ok", state: "restart-bound-state", expires_in: 120 }), undefined, true);
    await state.initialized();
    const start = await state.cpa.fetchWithAccess(new Request("https://gateway.example/v8/management/oauth/auth-url?provider=codex", {
      headers: { origin: "https://gateway.example", "x-management-key": "synthetic-management-key" },
    }));
    expect(start.status).toBe(200);
    expect(state.oauthOwners.get("restart-bound-state")).toBe("a".repeat(64));
    expect(state.starts).toHaveLength(1);

    // Simulate a process that exited while a browser still holds its callback URL.
    // A stale edge lookup must not wake a fresh process that lacks the PKCE verifier.
    state.stop();
    const staleCallback = await state.cpa.fetchWithAccess(new Request("https://gateway.example/callback?state=restart-bound-state&code=synthetic-code", {
      headers: { origin: "https://gateway.example" },
    }));
    expect(staleCallback.status).toBe(503);
    expect(state.starts).toHaveLength(1);
    expect(state.requests.some(request => new URL(request.url).pathname === "/callback")).toBe(false);

    // The next admitted cold start clears callback routing before launching a fresh CPA.
    const restart = await state.cpa.fetchWithAccess(new Request("https://gateway.example/runtime/start", {
      method: "POST", headers: await signedHeaders(),
    }));
    expect(restart.status).toBe(200);
    expect(state.starts).toHaveLength(2);
    expect(state.oauthOwners.has("restart-bound-state")).toBe(false);
    const releaseIndex = state.events.lastIndexOf("release_oauth_owner");
    const secondStartIndex = state.events.lastIndexOf("start");
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeLessThan(secondStartIndex);
  });
});

describe("R2 write fence at the persistence boundary", () => {
  it("serializes the conditional R2 put with lease ownership and rejects a stale writer", async () => {
    const bucketPut = vi.fn(async (key: string, value: ArrayBuffer) => ({
      key, size: value.byteLength, etag: "stored-version-2", uploaded: new Date(),
    }));
    const bucket = {
      head: async () => null,
      get: async () => null,
      put: bucketPut,
      delete: async () => undefined,
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket;
    const state = platform(true, Promise.resolve(), new LeaseStorage(), true, null, undefined, undefined, false, bucket);
    await state.initialized();
    const owner = "a".repeat(64) + ":" + "b".repeat(32);
    const lease = await state.cpa.claimPoolRefresh("resource-auth", owner, 90_000);
    if (lease === undefined) throw new Error("Expected a refresh lease");
    const body = new ArrayBuffer(4);
    expect(await state.cpa.writePoolObject("resource-auth", owner, lease.epoch,
      "auths/team/credential.json", body, "application/json", { ifMatch: "*" }))
      .toEqual({ ok: false, reason: "precondition_failed" });
    expect(bucketPut).not.toHaveBeenCalled();
    const result = await state.cpa.writePoolObject("resource-auth", owner, lease.epoch,
      "auths/team/credential.json", body, "application/json", { ifMatch: '"stored-version-1"' });
    expect(result).toMatchObject({ ok: true, object: { etag: "stored-version-2" } });
    expect(bucketPut).toHaveBeenCalledWith("auths/team/credential.json", body, expect.objectContaining({
      onlyIf: expect.objectContaining({ get: expect.any(Function) }),
      httpMetadata: { contentType: "application/json" },
    }));
    await state.cpa.releasePoolRefresh(lease);
    const stale = await state.cpa.writePoolObject("resource-auth", owner, lease.epoch,
      "auths/team/credential.json", body, "application/json", { ifMatch: '"stored-version-2"' });
    expect(stale).toEqual({ ok: false, reason: "stale_owner" });
    expect(bucketPut).toHaveBeenCalledTimes(1);
  });

  it("uses a conditional empty tombstone for deletes and refuses an ETag race", async () => {
    let etag = `"version-1"`;
    let value = new Uint8Array([1, 2, 3]);
    let raceOnce = true;
    const bucketHead = vi.fn(async () => ({ httpEtag: etag } as R2Object));
    const bucketPut = vi.fn(async (key: string, next: ArrayBuffer, options?: R2PutOptions) => {
      const condition = options?.onlyIf;
      if (!(condition instanceof Headers) || condition.get("if-match") !== etag) {
        return null;
      }
      if (raceOnce) {
        raceOnce = false;
        value = new Uint8Array([9, 9, 9]);
        etag = `"concurrent-version"`;
        return null;
      }
      value = new Uint8Array(next);
      etag = `"tombstone-version"`;
      return { key, size: next.byteLength, etag: etag.slice(1, -1), uploaded: new Date(), httpEtag: etag } as R2Object;
    });
    const bucket = {
      head: bucketHead,
      get: async () => null,
      put: bucketPut,
      delete: vi.fn(async () => undefined),
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket;
    const state = platform(false, Promise.resolve(), new LeaseStorage(), false, null, undefined, undefined, false, bucket);
    const owner = "a".repeat(64) + ":" + "b".repeat(32);
    const lease = await state.cpa.claimPoolRefresh("auth-key", owner, 90_000);
    if (lease === undefined) throw new Error("Expected a current object lease");
    expect(await state.cpa.deletePoolObject(lease.resource, owner, lease.epoch, "auths/team/key.json")).toBe(false);
    expect([...value]).toEqual([9, 9, 9]);
    expect(await state.cpa.deletePoolObject(lease.resource, owner, lease.epoch, "auths/team/key.json")).toBe(true);
    expect(value.byteLength).toBe(0);
    expect(bucketPut).toHaveBeenCalledTimes(2);
    expect(bucketHead).toHaveBeenCalledTimes(2);
    await state.cpa.releasePoolRefresh(lease);
    expect(await state.cpa.deletePoolObject(lease.resource, owner, lease.epoch, "auths/team/key.json")).toBe(false);
    expect(bucketPut).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale owner before mutation and accepts only a current conditional write", async () => {
    const store = new MemoryStore();
    const owner = "c".repeat(64) + ":" + "b".repeat(32);
    const valid = vi.fn(async (resource: string, candidate: string, epoch: number) => resource === "resource-a" && candidate === owner && epoch === 4);
    const env = {
      POOL_FENCING_ENABLED: "true", STATE: store,
      CPA: { getByName: () => ({
        writePoolObject: async (resource: string, candidate: string, epoch: number, key: string, value: ArrayBuffer, _type: string, condition: { ifMatch?: string; ifNoneMatch?: string }) => {
          if (!await valid(resource, candidate, epoch)) return { ok: false, reason: "stale_owner" } as const;
          const headers = new Headers();
          if (condition.ifMatch !== undefined) headers.set("if-match", condition.ifMatch);
          if (condition.ifNoneMatch !== undefined) headers.set("if-none-match", condition.ifNoneMatch);
          const stored = await store.put(key, value, { onlyIf: headers });
          return stored === null ? { ok: false, reason: "precondition_failed" } as const : { ok: true, object: {
            key: stored.key, size: stored.size, etag: stored.etag, uploadedAt: stored.uploaded.getTime(),
          } } as const;
        },
        deletePoolObject: async (resource: string, candidate: string, epoch: number, key: string) => {
          if (!await valid(resource, candidate, epoch)) return false;
          const current = await store.head(key);
          if (current === null) return true;
          return await store.put(key, new ArrayBuffer(0), {
            onlyIf: new Headers({ "if-match": "\"" + current.etag + "\"" }),
          }) !== null;
        },
      }) },
    } as unknown as Env;
    const bridge = new R2Bridge({ props: { containerId: "c".repeat(64) } } as unknown as ExecutionContext<{ containerId: string }>, env);
    const request = (epoch: number, candidate = owner) => new Request("http://r2.internal/state/config/config.yaml", {
      method: "PUT", headers: {
        "x-sub2api-resource": "resource-a", "x-sub2api-owner": candidate,
        "x-sub2api-epoch": String(epoch), "if-none-match": "*",
      }, body: "models: [fenced]\n",
    });
    expect((await bridge.fetch(request(4, "d".repeat(64) + ":" + "b".repeat(32)))).status).toBe(409);
    expect(valid).not.toHaveBeenCalled();
    expect(store.entries.size).toBe(0);
    expect((await bridge.fetch(request(3))).status).toBe(409);
    expect(store.entries.size).toBe(0);
    expect((await bridge.fetch(request(4))).status).toBe(200);
    expect(store.text("config/config.yaml")).toBe("models: [fenced]\n");
    const deleteRequest = (epoch: number) => new Request("http://r2.internal/state/config/config.yaml", {
      method: "DELETE", headers: {
        "x-sub2api-resource": "resource-a", "x-sub2api-owner": owner, "x-sub2api-epoch": String(epoch),
      },
    });
    expect((await bridge.fetch(deleteRequest(4))).status).toBe(204);
    expect(store.text("config/config.yaml")).toBe("");
    expect((await bridge.fetch(deleteRequest(3))).status).toBe(409);
    expect(store.text("config/config.yaml")).toBe("");
    expect(valid).toHaveBeenCalledTimes(4);
  });

  it("returns the acquired distributed fence to the Go refresh runner", async () => {
    const lease: FencedLease = {
      resource: "r-" + "1".repeat(64), owner: "c".repeat(64) + ":" + "d".repeat(32), epoch: 9, expiresAt: Date.now() + 90_000,
    };
    const calls: Array<{ action: string; resource?: string }> = [];
    const ownerStub = {
      fencedBackgroundActivity: async (action: string, id: string, resource: string) => {
        calls.push({ action, resource });
        return lease;
      },
    };
    const env = { CPA: { idFromString: (id: string) => ({ id }), get: () => ownerStub } } as unknown as Env;
    const bridge = new R2Bridge({ props: { containerId: "c".repeat(64) } } as unknown as ExecutionContext<{ containerId: string }>, env);
    const response = await bridge.fetch(new Request("http://r2.internal/__sub2api/activity", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "begin", id: "d".repeat(32), resource: lease.resource }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(lease);
    expect(calls).toEqual([{ action: "begin", resource: lease.resource }]);
  });
});

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
    expect(response.body).not.toBeNull();
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

  it.each([undefined, "wrong-key"])("never classifies unauthenticated inference (%s)", async key => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const hook = vi.spyOn(state.cpa as unknown as {prepareAuthenticatedInference(r: Request): Promise<Request>}, "prepareAuthenticatedInference");
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/chat/completions", {
      method: "POST", headers: key ? {authorization: `Bearer ${key}`} : {}, body: '{}',
    }));
    expect(response.status).toBe(401); expect(hook).not.toHaveBeenCalled(); expect(state.starts).toHaveLength(0);
  });

  it("classifies a verified key before starting the container", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true, configuration);
    await state.initialized();
    const hook = vi.spyOn(state.cpa as unknown as {prepareAuthenticatedInference(r: Request): Promise<Request>}, "prepareAuthenticatedInference");
    hook.mockImplementation(async request => { expect(state.starts).toHaveLength(0); return request; });
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/chat/completions", {
      method: "POST", headers: {authorization: `Bearer ${CLIENT_KEY}`}, body: '{}',
    }));
    expect(response.status).toBe(200); expect(hook).toHaveBeenCalledTimes(1); expect(state.starts).toHaveLength(1);
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
    expect(state.events).toContain("port_fetch");
  });

  it("preserves native wake when an enabled plugin must decide authentication", async () => {
    const state = platform(false, Promise.resolve(), new LeaseStorage(), true,
      "config-version: 8\nplugins:\n  enabled: true\n  configs:\n    frontend-auth:\n      enabled: true\n");
    await state.initialized();
    const hook = vi.spyOn(state.cpa as unknown as {prepareAuthenticatedInference(r: Request): Promise<Request>}, "prepareAuthenticatedInference");
    expect((await state.cpa.fetch(new Request("https://gateway.example/v1/models", { headers: { authorization: "plugin-credential" } }))).status).toBe(200);
    expect(hook).not.toHaveBeenCalled();
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
    const readyResponse = await state.cpa.fetch(new Request("https://gateway.example/readyz"));
    expect(readyResponse.status).toBe(200);
    await readyResponse.arrayBuffer();
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
    const readyResponse = await state.cpa.fetch(new Request("https://gateway.example/readyz"));
    expect(readyResponse.status).toBe(200);
    await readyResponse.arrayBuffer();
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
    await (await state.cpa.fetch(new Request("https://gateway.example/readyz"))).arrayBuffer();
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
    const readyResponse = await state.cpa.fetch(new Request("https://gateway.example/readyz"));
    expect(readyResponse.status).toBe(200);
    await readyResponse.arrayBuffer();
    expect(state.events.filter((event) => event.startsWith("restore_timeout:"))).toEqual(expect.arrayContaining(["restore_timeout:1800000", "restore_timeout:1000"]));
    const after = new BackgroundActivity(storage);
    await after.restore();
    expect(after.remainingMs()).toBe(0);
    const oauthAfter = new OAuthLease(storage);
    await oauthAfter.restore();
    expect(oauthAfter.remainingMs()).toBe(0);
    expect(state.events.filter((event) => event === "start")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispatches internal activity to the Durable Object ID supplied as RPC props", async () => {
    const calls: Array<{ name: string; action: BackgroundAction; id: string }> = [];
    const ownerId = "b".repeat(64);
    const env = {
      CPA: {
        idFromString: (id: string) => ({ id }),
        get: (id: { id: string }) => ({ backgroundActivity: async (action: BackgroundAction, activityId: string) => {
          calls.push({ name: id.id, action, id: activityId });
          return true;
        } }),
      },
    };
    const bridge = new R2Bridge({ props: { containerId: ownerId } } as unknown as ExecutionContext<{ containerId: string }>, env as unknown as Env);
    const response = await bridge.fetch(new Request("http://r2.internal/__sub2api/activity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "begin", id: firstId }),
    }));
    expect(response.status).toBe(204);
    expect(calls).toEqual([{ name: ownerId, action: "begin", id: firstId }]);
  });

  it("accepts bounded, hash-only durable affinity RPCs and returns CAS conflicts", async () => {
    const ownerId = "c".repeat(64);
    const calls: Array<{ op: string; key: string; ownerId: string; expectedVersion?: number; authId?: string }> = [];
    const coordinator = {
      readPoolSessionAffinity: async (key: string, calledOwnerId: string) => {
        calls.push({ op: "read", key, ownerId: calledOwnerId });
        return { authId: "", owner: "", version: 0, expiresAt: 0 };
      },
      bindPoolSessionAffinity: async (key: string, expectedVersion: number, calledOwnerId: string, authId: string) => {
        calls.push({ op: "bind", key, ownerId: calledOwnerId, expectedVersion, authId });
        return { ok: false as const, record: { authId: "credential-current", owner: calledOwnerId, version: 4, expiresAt: Date.now() + 60_000 } };
      },
      deletePoolSessionAffinity: async () => false,
    };
    const env = {
      POOL_FENCING_ENABLED: "true", POOL_SESSION_ROUTING_ENABLED: "true", POOL_SESSION_AFFINITY_ENABLED: "true",
      CPA: { getByName: (name: string) => {
      expect(name).toBe("cf-pool-coordinator-v1");
      return coordinator;
    } } } as unknown as Env;
    const bridge = new R2Bridge({ props: { containerId: ownerId } } as unknown as ExecutionContext<{ containerId: string }>, env);
    const key = "d".repeat(64);
    const read = await bridge.fetch(new Request("http://r2.internal/__sub2api/session-affinity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "read", key }),
    }));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ authId: "", owner: "", version: 0, expiresAt: 0 });
    const conflict = await bridge.fetch(new Request("http://r2.internal/__sub2api/session-affinity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        op: "bind", key, expectedVersion: 0, authId: "credential-stale", ttlMs: 60_000,
      }),
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, record: { authId: "credential-current", version: 4 } });
    expect(calls).toEqual([
      { op: "read", key, ownerId },
      { op: "bind", key, ownerId, expectedVersion: 0, authId: "credential-stale" },
    ]);
    expect((await bridge.fetch(new Request("http://r2.internal/__sub2api/session-affinity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "read", key, owner: "d".repeat(64) }),
    }))).status).toBe(400);
    expect(calls).toHaveLength(2);
    expect((await bridge.fetch(new Request("http://r2.internal/__sub2api/session-affinity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        op: "read", key: "raw-session-id",
      }),
    }))).status).toBe(400);
    const orphan = new R2Bridge({ props: {} } as unknown as ExecutionContext<{ containerId: string }>, env);
    expect((await orphan.fetch(new Request("http://r2.internal/__sub2api/session-affinity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "read", key }),
    }))).status).toBe(404);
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
      new URL(request.url).pathname === "/v1/realtime/client_secrets" ? minted : new Response(null));
    await state.initialized();
    const response = await state.cpa.fetch(new Request("https://gateway.example/v1/realtime/client_secrets", { method: "POST", headers: authorization }));
    expect(response.status).toBe(minted.status);
    expect(response.bodyUsed).toBe(false);
    await response.arrayBuffer();
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
    expect(response.status).toBe(upstream.status);
    expect([...response.headers]).toEqual([...upstream.headers]);
    expect(clone).not.toHaveBeenCalled();
    expect(pulls).toBe(0);
    expect(Number(lastTimeout(state.events)?.split(":")[1])).toBeGreaterThan(80000);
    expect(await response.text()).toBe("data: model output\n\n");
    expect(lastTimeout(state.events)).toBe("restore_timeout:1000");
  });
});
