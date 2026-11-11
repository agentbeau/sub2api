import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainerLifecycle, containerIdleTimeout, type ContainerBackend } from "../src/container-lifecycle.ts";
import { OAuthLease } from "../src/oauth-lease.ts";
import { LeaseStorage } from "./lease-storage.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Only the platform container and TCP-port operations are replaced. Requests, responses,
// streams, AbortSignals and the lifecycle controller under test use their real implementations.
class PlatformContainer implements ContainerBackend {
  running = false;
  readonly starts: ContainerStartupOptions[] = [];
  readonly timeouts: number[] = [];
  readonly requests: Request[] = [];
  readonly ports: number[] = [];
  startError: Error | undefined;
  health: (request: Request) => Promise<Response> = async () => new Response("ok");
  capability: (request: Request) => Promise<Response> = async () => Response.json({ activity_protocol: 1 });
  upstream: (request: Request) => Promise<Response> = async () => new Response("provider reply");

  start(options?: ContainerStartupOptions): void {
    if (this.startError !== undefined) throw this.startError;
    if (this.running) throw new Error("A second start raced with an active container");
    if (options === undefined) throw new Error("Startup must explicitly configure egress and environment");
    this.starts.push(options);
    this.running = true;
  }

  async setInactivityTimeout(timeout: number | bigint): Promise<void> {
    this.timeouts.push(Number(timeout));
  }

  getTcpPort(port: number): Pick<Fetcher, "fetch"> {
    this.ports.push(port);
    return { fetch: async (input, init) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      this.requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/healthz") return this.health(request);
      if (path === "/__sub2api/lifecycle") return this.capability(request);
      return this.upstream(request);
    } };
  }
}

function lifecycle(container = new PlatformContainer(), idleTimeout?: string, lease = new OAuthLease(new LeaseStorage())) {
  const attached: string[] = [];
  let environmentReads = 0;
  const controller = new ContainerLifecycle(container, {
    idleTimeout,
    lease,
    environment: async () => {
      environmentReads += 1;
      return { OBJECTSTORE_ENDPOINT: "http://r2.internal", CPA_IMPORT_CONFIG: "access:\n  api-keys: [saved-key]" };
    },
    attach: async () => { attached.push("r2.internal"); },
  });
  return { controller, container, attached, environmentReads: () => environmentReads };
}

function management(path: string, method = "GET") {
  return new Request(`https://gateway.example/v8/management/${path}`, {
    method, headers: { authorization: "Bearer accepted-management-key" },
  });
}

async function seedOAuth(lease: OAuthLease, state = "pending-state", expiresIn = 120) {
  await lease.observe(management("oauth/auth-url"), Response.json({
    status: "ok", state, url: `https://provider.example/authorize?state=${state}`, expires_in: expiresIn,
  }));
}

afterEach(() => { vi.useRealTimers(); });

describe("container idle timeout", () => {
  it("accepts the shortest positive setting and the platform upper boundary", () => {
    expect(containerIdleTimeout()).toBe(1000);
    expect(containerIdleTimeout("1")).toBe(1);
    expect(containerIdleTimeout("21600000")).toBe(21600000);
  });

  it.each(["", "0", "-1", "1.5", "Infinity", "NaN", "21600001", "1000ms", "1e3"])("rejects %j instead of leaving a container indefinitely warm", (value) => {
    expect(() => containerIdleTimeout(value)).toThrow(/CONTAINER_IDLE_TIMEOUT_MS/);
  });
});

describe("container image rollout compatibility", () => {
  it("checks the marker on actual internal activity while retaining legacy idle for an unsupported image", async () => {
    const platform = new PlatformContainer();
    platform.running = true;
    platform.capability = async () => new Response(null, { status: 404 });
    const state = lifecycle(platform);
    await state.controller.restore();
    await state.controller.refreshTimeout({ detectProtocol: true });
    expect(platform.timeouts).toEqual([1_800_000]);
    expect(platform.requests.map((request) => new URL(request.url).pathname)).toEqual(["/__sub2api/lifecycle"]);
    expect(platform.starts).toHaveLength(0);
  });

  it("reattaches a legacy image with its conservative idle floor and no background polling", async () => {
    vi.useFakeTimers();
    const platform = new PlatformContainer();
    platform.running = true;
    platform.capability = async () => new Response(null, { status: 404 });
    const state = lifecycle(platform, "1");
    await state.controller.restore();
    expect(platform.timeouts).toEqual([1_800_000]);
    expect(platform.requests).toHaveLength(0);
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
    expect(platform.timeouts.at(-1)).toBe(1_800_000);
    expect(platform.requests.filter((request) => new URL(request.url).pathname === "/__sub2api/lifecycle")).toHaveLength(1);
    const requests = platform.requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(platform.requests).toHaveLength(requests);
    expect(vi.getTimerCount()).toBe(0);
    expect(platform.starts).toHaveLength(0);
  });

  it("detects a replacement image only when another real request arrives", async () => {
    const state = lifecycle();
    state.container.capability = async () => new Response(null, { status: 404 });
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
    expect(state.container.timeouts.at(-1)).toBe(1_800_000);
    state.container.capability = async () => Response.json({ activity_protocol: 1 });
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
    expect(state.container.timeouts.at(-1)).toBe(1000);
    expect(state.container.starts).toHaveLength(1);
    expect(state.container.requests.filter((request) => new URL(request.url).pathname === "/__sub2api/lifecycle")).toHaveLength(2);
  });

  it("confirms readiness and protocol support before aggressive idle or the waiting POST", async () => {
    const marker = deferred<Response>();
    const state = lifecycle(new PlatformContainer(), "1");
    state.container.capability = () => marker.promise;
    const pending = state.controller.forward(new Request("https://gateway.example/v1/messages", { method: "POST", body: "once" }));
    await vi.waitFor(() => { expect(state.container.requests.some((request) => new URL(request.url).pathname === "/__sub2api/lifecycle")).toBe(true); });
    expect(state.container.timeouts).toEqual([1_800_000]);
    expect(state.container.requests.some((request) => request.method === "POST")).toBe(false);
    marker.resolve(Response.json({ activity_protocol: 1 }));
    expect((await pending).status).toBe(200);
    expect(state.container.timeouts).toEqual([1_800_000, 1]);
    expect(state.container.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["unsupported protocol", () => Response.json({ activity_protocol: 2 })],
    ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["unconfigured hooks", () => Response.json({ activity_protocol: 1 }, { status: 503 })],
    ["oversized marker", () => Response.json({ activity_protocol: 1, padding: "x".repeat(2048) })],
  ] as const)("preserves service with conservative idle for %s", async (_name, response) => {
    const state = lifecycle();
    state.container.capability = async () => response();
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
    expect(state.container.timeouts.at(-1)).toBe(1_800_000);
  });

  it("bounds an unresponsive capability probe without disabling a healthy legacy image", async () => {
    vi.useFakeTimers();
    const state = lifecycle();
    state.container.capability = async () => new Promise<Response>(() => {});
    const pending = state.controller.forward(new Request("https://gateway.example/v1/models"));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(200);
    expect(state.container.timeouts.at(-1)).toBe(1_800_000);
    const probe = state.container.requests.find((request) => new URL(request.url).pathname === "/__sub2api/lifecycle");
    expect(probe?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks protocol support after a confirmed process restart", async () => {
    const state = lifecycle();
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    expect(state.container.timeouts.at(-1)).toBe(1000);
    state.container.running = false;
    state.container.capability = async () => new Response(null, { status: 404 });
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    expect(state.container.timeouts).toEqual([1_800_000, 1000, 1_800_000]);
    expect(state.container.starts).toHaveLength(2);
  });
});

describe("native container lifecycle", () => {
  it("does not start or read saved imports when constructed or restoring a stopped container", async () => {
    const state = lifecycle();
    await state.controller.restore();
    expect(state.container.running).toBe(false);
    expect(state.container.starts).toHaveLength(0);
    expect(state.attached).toEqual([]);
    expect(state.environmentReads()).toBe(0);
  });

  it("restores egress interception and safe rollout idle without restarting a running container", async () => {
    const platform = new PlatformContainer();
    platform.running = true;
    const state = lifecycle(platform, "1");
    await state.controller.restore();
    expect(platform.starts).toHaveLength(0);
    expect(platform.timeouts).toEqual([1_800_000]);
    expect(state.attached).toEqual(["r2.internal"]);
    expect(state.environmentReads()).toBe(0);
    expect(platform.requests).toHaveLength(0);
  });

  it("coordinates a cold start before sending each concurrent inference exactly once", async () => {
    const probe = deferred<Response>();
    const platform = new PlatformContainer();
    platform.health = () => probe.promise;
    platform.upstream = async (request) => new Response(await request.text());
    const state = lifecycle(platform);
    const first = state.controller.forward(new Request("https://gateway.example/v1/messages?model=one", {
      method: "POST", headers: { host: "gateway.example", authorization: "Bearer client-key" }, body: "first request",
    }));
    const second = state.controller.forward(new Request("https://gateway.example/v1/messages?model=two", { method: "POST", body: "second request" }));
    await vi.waitFor(() => { expect(platform.requests).toHaveLength(1); });
    expect(platform.starts).toEqual([{ enableInternet: true, env: { OBJECTSTORE_ENDPOINT: "http://r2.internal", CPA_IMPORT_CONFIG: "access:\n  api-keys: [saved-key]" } }]);
    expect(platform.requests[0]?.url).toBe("http://container/healthz");
    expect(state.attached).toEqual(["r2.internal"]);
    probe.resolve(new Response("ready"));
    expect(await (await first).text()).toBe("first request");
    expect(await (await second).text()).toBe("second request");
    expect(state.environmentReads()).toBe(1);
    const submitted = platform.requests.filter((request) => request.method === "POST");
    expect(submitted.map((request) => request.url)).toEqual(["http://container/v1/messages?model=one", "http://container/v1/messages?model=two"]);
    expect(submitted[0]?.headers.get("host")).toBeNull();
    expect(submitted[0]?.headers.get("authorization")).toBe("Bearer client-key");
    expect(platform.timeouts).toEqual([1_800_000, 1000]);
    expect(platform.ports.every((port) => port === 8317)).toBe(true);
  });

  it("does not probe or reload imports for each request to an already ready container", async () => {
    const state = lifecycle();
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
    expect(state.container.requests.filter((request) => new URL(request.url).pathname === "/healthz")).toHaveLength(1);
    expect(state.environmentReads()).toBe(1);
  });

  it("waits for a healthy port and discards probe bodies before forwarding", async () => {
    vi.useFakeTimers();
    const state = lifecycle();
    let probes = 0;
    let discarded = false;
    state.container.health = async () => {
      probes += 1;
      return probes === 1
        ? new Response(new ReadableStream({ cancel() { discarded = true; } }), { status: 503 })
        : new Response("ready");
    };
    const response = state.controller.forward(new Request("https://gateway.example/v1/models"));
    await vi.advanceTimersByTimeAsync(200);
    expect((await response).status).toBe(200);
    expect(discarded).toBe(true);
    expect(probes).toBe(2);
  });

  it("bounds an unresponsive readiness probe and never submits the waiting POST", async () => {
    vi.useFakeTimers();
    const state = lifecycle();
    state.container.health = async () => new Promise<Response>(() => {});
    const pending = state.controller.forward(new Request("https://gateway.example/v1/messages", { method: "POST", body: "must not run" }));
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.container.requests.every((request) => request.method === "GET")).toBe(true);
    expect(state.container.requests.every((request) => request.signal.aborted)).toBe(true);
    state.container.health = async () => new Response("ready");
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
  });

  it("returns a retryable startup failure and allows the next request to recover", async () => {
    const state = lifecycle();
    state.container.startError = new Error("allocation unavailable");
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(503);
    expect(state.container.requests).toHaveLength(0);
    state.container.startError = undefined;
    expect((await state.controller.forward(new Request("https://gateway.example/v1/models"))).status).toBe(200);
  });

  it("reconfigures a stopped container after its prior idle shutdown", async () => {
    const state = lifecycle();
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    state.container.running = false;
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    expect(state.container.starts).toHaveLength(2);
    expect(state.container.timeouts).toEqual([1_800_000, 1000, 1_800_000, 1000]);
    expect(state.attached).toEqual(["r2.internal", "r2.internal"]);
  });

  it("does not retry a submitted inference after the provider connection fails", async () => {
    const state = lifecycle();
    let submissions = 0;
    state.container.upstream = async () => { submissions += 1; throw new Error("connection interrupted"); };
    const response = await state.controller.forward(new Request("https://gateway.example/v1/messages", { method: "POST", body: "one billed request" }));
    expect(response.status).toBe(503);
    expect(submissions).toBe(1);
  });

  it("returns the original response stream before its first chunk and propagates cancellation", async () => {
    const state = lifecycle();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { cancelled = true; } }), {
      headers: { "content-type": "text/event-stream" },
    });
    state.container.upstream = async () => upstream;
    const response = await state.controller.forward(new Request("https://gateway.example/v1/messages", {
      method: "POST", headers: { authorization: "Bearer inference-key" }, body: "stream",
    }));
    expect(response).toBe(upstream);
    stream?.enqueue(new TextEncoder().encode("data: token\n\n"));
    if (response.body === null) throw new Error("Expected a streaming response body");
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: token\n\n");
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("passes WebSocket upgrade headers and preserves the platform upgrade response", async () => {
    const state = lifecycle();
    // Node's Response forbids101; the external port supplies this platform response envelope.
    const upgrade = new Response(null);
    Object.defineProperty(upgrade, "status", { value: 101 });
    Object.defineProperty(upgrade, "webSocket", { value: { readyState: 0 } });
    state.container.upstream = async (request) => {
      expect(request.headers.get("upgrade")).toBe("websocket");
      return upgrade;
    };
    const response = await state.controller.forward(new Request("https://gateway.example/v1/realtime?model=voice", { headers: { upgrade: "websocket" } }));
    expect(response).toBe(upgrade);
    expect(response.status).toBe(101);
  });

  it("does not start a container for a request that was already cancelled", async () => {
    const state = lifecycle();
    const abort = new AbortController();
    abort.abort();
    await state.controller.forward(new Request("https://gateway.example/v1/messages", { method: "POST", body: "cancelled", signal: abort.signal }));
    expect(state.container.starts).toHaveLength(0);
    expect(state.environmentReads()).toBe(0);
  });
});

describe("native inactivity with persisted activity leases", () => {
  it("protects a newly started OAuth flow and does not renew it when requests poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = lifecycle();
    state.container.upstream = async (request) => new URL(request.url).pathname.endsWith("/auth-url")
      ? Response.json({ status: "ok", state: "flow-a", expires_in: 120, url: "https://provider.example/authorize" })
      : Response.json({ status: "wait" });
    await state.controller.forward(management("oauth/auth-url"));
    expect(state.container.timeouts.at(-1)).toBe(180_000);

    vi.setSystemTime(1_020_000);
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    expect(state.container.timeouts.at(-1)).toBe(160_000);
    vi.setSystemTime(1_030_000);
    await state.controller.forward(management("oauth/status?state=flow-a"));
    expect(state.container.timeouts.at(-1)).toBe(150_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores a persisted lease before setting native idle on an already running container", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new LeaseStorage();
    await seedOAuth(new OAuthLease(storage), "long-device-flow", 1800);
    vi.setSystemTime(1_020_000);
    const restored = new OAuthLease(storage);
    await restored.restore();
    const platform = new PlatformContainer();
    platform.running = true;
    const state = lifecycle(platform, "1", restored);
    await state.controller.restore();
    expect(platform.timeouts).toEqual([1_840_000]);
    expect(platform.starts).toHaveLength(0);
    expect(platform.requests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds successful management mutations for storage sync then returns to cached ordinary idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = lifecycle();
    state.container.upstream = async () => Response.json({ status: "ok" });
    await state.controller.forward(management("config", "PATCH"));
    expect(state.container.timeouts.at(-1)).toBe(35_000);
    vi.setSystemTime(1_015_000);
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    expect(state.container.timeouts.at(-1)).toBe(20_000);
    vi.setSystemTime(1_036_000);
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    expect(state.container.timeouts.at(-1)).toBe(1000);
    const writes = state.container.timeouts.length;
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    expect(state.container.timeouts).toHaveLength(writes);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a bounded write grace when OAuth completes without extending it on repeated status polls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const lease = new OAuthLease(new LeaseStorage());
    await seedOAuth(lease);
    const state = lifecycle(new PlatformContainer(), undefined, lease);
    state.container.upstream = async () => Response.json({ status: "ok" });
    await state.controller.forward(management("oauth/status?state=pending-state"));
    expect(state.container.timeouts.at(-1)).toBe(35_000);
    vi.setSystemTime(1_015_000);
    await state.controller.forward(management("oauth/status?state=pending-state"));
    expect(state.container.timeouts.at(-1)).toBe(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never lowers a configured longer idle timeout for a shorter write grace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = lifecycle(new PlatformContainer(), "60000");
    state.container.upstream = async () => Response.json({ status: "ok" });
    await state.controller.forward(management("config", "PATCH"));
    expect(state.container.timeouts).toEqual([1_800_000, 60_000]);
  });

  it("serializes overlapping native timeout updates and applies the latest OAuth deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const lease = new OAuthLease(new LeaseStorage());
    await seedOAuth(lease);
    const platform = new PlatformContainer();
    const state = lifecycle(platform, undefined, lease);
    await state.controller.forward(new Request("https://gateway.example/v1/models"));
    const gate = deferred<undefined>();
    let updating = false;
    let overlap = false;
    platform.setInactivityTimeout = async (timeout) => {
      overlap ||= updating;
      updating = true;
      platform.timeouts.push(Number(timeout));
      if (timeout === 170_000) await gate.promise;
      updating = false;
    };
    platform.upstream = async (request) => new URL(request.url).pathname.endsWith("/auth-url")
      ? Response.json({ status: "ok", state: "flow-b", expires_in: 120, url: "https://provider.example/authorize" })
      : Response.json({ status: "ok" });
    vi.setSystemTime(1_010_000);
    const first = state.controller.forward(new Request("https://gateway.example/v1/models"));
    const second = state.controller.forward(management("oauth/auth-url"));
    await vi.advanceTimersByTimeAsync(0);
    expect(platform.timeouts.at(-1)).toBe(170_000);
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(overlap).toBe(false);
    expect(platform.timeouts.at(-1)).toBe(180_000);
  });
});
