import type { OAuthLease } from "./oauth-lease.ts";

export type ContainerBackend = Pick<Container, "running" | "start" | "setInactivityTimeout"> & {
  getTcpPort(port: number): Pick<Fetcher, "fetch">;
};

export interface LifecycleOptions {
  readonly idleTimeout: string | undefined;
  readonly environment: () => Promise<Record<string, string>>;
  readonly attach: () => Promise<void>;
  readonly lease?: Pick<OAuthLease, "remainingMs" | "observe">;
  readonly beforeStart?: () => Promise<void>;
}

export interface ForwardOptions {
  readonly requireFrontendAuth?: boolean;
}

interface RuntimeProtocols {
  readonly activity: boolean;
  readonly frontendAuth: boolean;
  readonly initialization: boolean;
  readonly initializationReady: boolean;
}

const NO_PROTOCOLS: RuntimeProtocols = { activity: false, frontendAuth: false, initialization: false, initializationReady: false };
const PORT = 8317;
const STARTUP_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1000;
const PROBE_INTERVAL_MS = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 1000;
const MAX_IDLE_TIMEOUT_MS = 21_600_000;
const LEGACY_IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_CAPABILITY_BYTES = 1024;
const RUNTIME_ASLEEP = Symbol("runtime_asleep");
const INITIALIZATION_UNSUPPORTED = Symbol("initialization_unsupported");
const FOREGROUND_HOLD_MS = 90_000;
const FOREGROUND_RENEW_MS = 30_000;

export function containerIdleTimeout(value?: string): number {
  if (value === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const text = value.trim();
  const timeout = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_IDLE_TIMEOUT_MS) {
    throw new RangeError("CONTAINER_IDLE_TIMEOUT_MS must be a whole number from 1 through 21600000");
  }
  return timeout;
}

export function containerUnavailable(): Response {
  return Response.json({ error: { type: "api_error", message: "The gateway is starting or unavailable. Try again shortly." } }, {
    status: 503,
    headers: { "cache-control": "no-store", "retry-after": "1" },
  });
}

function containerAsleep(): Response {
  return Response.json({ error: { type: "api_error", code: "runtime_asleep", message: "The provider runtime is asleep. Start provider controls or send an authorized API request." } }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

function containerUpgradeRequired(): Response {
  return Response.json({ error: { type: "api_error", code: "runtime_upgrade_required", message: "The provider runtime needs an update before it can accept API requests." } }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

// Bound setup as well as each health probe. The abort race also handles a platform operation
// that has not settled yet; code checks the signal before starting or forwarding anything.
async function within<T>(milliseconds: number, operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  parent?.throwIfAborted();
  const onParentAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Container startup timed out")), milliseconds);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

async function readProtocols(response: Response, signal: AbortSignal): Promise<RuntimeProtocols> {
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {});
    return NO_PROTOCOLS;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return NO_PROTOCOLS;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const bytes = new Uint8Array(MAX_CAPABILITY_BYTES);
    let length = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) return NO_PROTOCOLS;
      bytes.set(value, length);
      length += value.byteLength;
    }
    signal.throwIfAborted();
    const marker: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    if (typeof marker !== "object" || marker === null) return NO_PROTOCOLS;
    return {
      activity: "activity_protocol" in marker && marker.activity_protocol === 1,
      frontendAuth: "frontend_auth_protocol" in marker && marker.frontend_auth_protocol === 1,
      initialization: "initialization_protocol" in marker && marker.initialization_protocol === 1 &&
        "initialization_ready" in marker && typeof marker.initialization_ready === "boolean",
      initializationReady: "initialization_ready" in marker && marker.initialization_ready === true,
    };
  } catch {
    return NO_PROTOCOLS;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export class ContainerLifecycle {
  private starting: Promise<void> | undefined;
  private existingReadiness: Promise<void> | undefined;
  private ready = false;
  private baseIdleTimeout: number | undefined;
  private appliedIdleTimeout: number | undefined;
  private timeoutUpdate: Promise<void> | undefined;
  private activityProtocol = false;
  private frontendAuthProtocol = false;
  private initializationProtocol = false;
  private initializationReady = false;
  private capabilityCheck: Promise<void> | undefined;
  private incarnation = 0;
  private readonly foreground = new Map<symbol, number>();

  constructor(private readonly container: ContainerBackend, private readonly options: LifecycleOptions) {}

  // A DO can restart while its container stays alive. Restore the timeout and replace the
  // outbound handler; actual forwarding or job notifications will confirm protocol support.
  async restore(): Promise<void> {
    if (!this.container.running) return;
    await within(STARTUP_TIMEOUT_MS, async (signal) => {
      await this.options.attach();
      signal.throwIfAborted();
      await this.applyInactivityTimeout(true);
    });
  }

  async refreshTimeout(options: { readonly detectProtocol?: boolean } = {}): Promise<void> {
    // Activity notifications must never allocate or probe a stopped container.
    if (!this.container.running) return;
    if (options.detectProtocol && !this.activityProtocol) await this.checkProtocols();
    if (this.container.running) await this.applyInactivityTimeout();
  }

  forward(request: Request, options: ForwardOptions = {}): Promise<Response> {
    return this.forwardRequest(request, true, options.requireFrontendAuth === true);
  }

  // Dashboard reads and management requests may use a live process, but only an explicitly
  // admitted API request or controls action can call the native wake path above.
  forwardExisting(request: Request, options: ForwardOptions = {}): Promise<Response> {
    return this.forwardRequest(request, false, options.requireFrontendAuth === true);
  }

  private async forwardRequest(request: Request, allowStart: boolean, requireFrontendAuth: boolean): Promise<Response> {
    let foreground: Awaited<ReturnType<ContainerLifecycle["beginForeground"]>> | undefined;
    try {
      request.signal.throwIfAborted();
      await (allowStart ? this.ensureReady(requireFrontendAuth) : this.ensureExistingReady(requireFrontendAuth));
      if (!allowStart) this.requireRunning();
      await this.applyInactivityTimeout();
      request.signal.throwIfAborted();
      if (!allowStart) this.requireRunning();
      // Activity reporting predates the fail-closed frontend authentication patch. Check its
      // separate marker before forwarding any API body to a process from a mixed rollout.
      if (requireFrontendAuth && !this.frontendAuthProtocol) return containerUpgradeRequired();
      const url = new URL(request.url);
      url.protocol = "http:";
      url.host = "container";
      foreground = await this.beginForeground(request);
      request.signal.throwIfAborted();
      const forwarded = new Request(url, new Request(request, { signal: foreground.signal }));
      forwarded.headers.delete("host");
      const response = await this.container.getTcpPort(PORT).fetch(forwarded);
      try {
        // The lease inspects only bounded credential and management JSON. Inference streams and upgrade
        // responses pass through untouched, without cloning, buffering or retrying them.
        await this.options.lease?.observe(request, response);
      } finally {
        // Preserve the in-memory hold even if persisting it failed. Recompute from absolute
        // deadlines so unrelated requests and status polling cannot renew an OAuth lease.
        await this.applyInactivityTimeout();
      }
      return await foreground.wrap(response);
    } catch (error) {
      await foreground?.cancel(error);
      this.ready = false;
      if (error === INITIALIZATION_UNSUPPORTED) return containerUpgradeRequired();
      if (!allowStart && (error === RUNTIME_ASLEEP || !this.container.running)) return containerAsleep();
      return containerUnavailable();
    }
  }

  // The platform fetch resolves at headers, not at stream completion. Keep a
  // foreground hold until the returned body reaches EOF, fails, or is cancelled.
  // Renew only existing work: this never wakes a stopped container or replays it.
  private async beginForeground(request: Request) {
    const id = Symbol("foreground");
    const incarnation = this.incarnation;
    const abort = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const finish = async () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      this.foreground.delete(id);
      if (this.container.running) {
        try { await this.applyInactivityTimeout(); } catch {
          console.error({ event: "container_foreground_release_failed" });
        }
      }
    };
    const onAbort = () => {
      abort.abort(request.signal.reason);
      if (reader) void reader.cancel(request.signal.reason).catch(() => {});
      void finish();
    };
    const renew = async () => {
      if (!active) return;
      if (!this.container.running || incarnation !== this.incarnation) {
        abort.abort(new Error("Provider runtime stopped during request"));
        if (reader) void reader.cancel(abort.signal.reason).catch(() => {});
        await finish();
        return;
      }
      this.foreground.set(id, Date.now() + FOREGROUND_HOLD_MS);
      try { await this.applyInactivityTimeout(true); } catch {
        abort.abort(new Error("Provider foreground hold could not be renewed"));
        if (reader) void reader.cancel(abort.signal.reason).catch(() => {});
        await finish();
        return;
      }
      if (active) timer = setTimeout(() => { void renew(); }, FOREGROUND_RENEW_MS);
    };
    request.signal.throwIfAborted();
    this.foreground.set(id, Date.now() + FOREGROUND_HOLD_MS);
    request.signal.addEventListener("abort", onAbort, { once: true });
    try { await this.applyInactivityTimeout(); } catch (error) { await finish(); throw error; }
    if (active) timer = setTimeout(() => { void renew(); }, FOREGROUND_RENEW_MS);
    return {
      signal: abort.signal,
      finish,
      cancel: async (reason: unknown) => {
        abort.abort(reason);
        if (reader) void reader.cancel(reason).catch(() => {});
        await finish();
      },
      wrap: async (response: Response): Promise<Response> => {
        // WebSocket lifecycle uses the existing realtime credential hold. A null
        // body has no outstanding HTTP stream to protect.
        if (response.body === null || response.webSocket) { await finish(); return response; }
        if (abort.signal.aborted) {
          void response.body.cancel(abort.signal.reason).catch(() => {});
          abort.signal.throwIfAborted();
        }
        reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          pull: async controller => {
            try {
              abort.signal.throwIfAborted();
              const result = await reader?.read();
              abort.signal.throwIfAborted();
              if (result?.done || result === undefined) { await finish(); controller.close(); }
              else controller.enqueue(result.value);
            } catch (error) {
              await finish();
              controller.error(error);
            }
          },
          cancel: async reason => {
            abort.abort(reason);
            const cancelled = reader?.cancel(reason);
            await finish();
            await cancelled;
          },
        }, { highWaterMark: 0 });
        return new Response(body, { status: response.status, statusText: response.statusText,
          headers: response.headers, cf: response.cf, encodeBody: "manual" });
      },
    };
  }

  private effectiveIdleTimeout(): number {
    this.baseIdleTimeout ??= containerIdleTimeout(this.options.idleTimeout);
    // Worker code is deployed before the default-policy image rollout completes. An old
    // process cannot notify us about background work, so retain its prior idle allowance.
    return Math.max(this.baseIdleTimeout, this.activityProtocol && this.initializationReady ? 0 : LEGACY_IDLE_TIMEOUT_MS, Math.ceil(this.options.lease?.remainingMs() ?? 0), ...[...this.foreground.values()].map(until => Math.max(0, until - Date.now())));
  }

  private applyInactivityTimeout(force = false): Promise<void> {
    if (!force && this.timeoutUpdate === undefined && this.appliedIdleTimeout === this.effectiveIdleTimeout()) {
      return Promise.resolve();
    }
    // Serialize platform writes and read the current lease only when this write runs. A slow
    // earlier request must not overwrite a newer request's OAuth or persistence deadline.
    const update = (this.timeoutUpdate ?? Promise.resolve()).catch(() => {}).then(async () => {
      const timeout = this.effectiveIdleTimeout();
      if (force || timeout !== this.appliedIdleTimeout) {
        await within(STARTUP_TIMEOUT_MS, () => this.container.setInactivityTimeout(timeout));
        this.appliedIdleTimeout = timeout;
      }
    });
    this.timeoutUpdate = update;
    const settled = () => { if (this.timeoutUpdate === update) this.timeoutUpdate = undefined; };
    void update.then(settled, settled);
    return update;
  }

  private ensureReady(requireFrontendAuth: boolean): Promise<void> {
    if (this.ready && this.container.running) {
      // Retry only on an actual forwarded request while an old image remains in service.
      // A supported process needs no additional capability requests or polling timer.
      return this.activityProtocol && (!requireFrontendAuth || this.frontendAuthProtocol) ? Promise.resolve() : this.checkProtocols();
    }
    this.ready = false;
    this.starting ??= within(STARTUP_TIMEOUT_MS, (signal) => this.startAndWait(signal)).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private requireRunning(): void {
    if (!this.container.running) throw RUNTIME_ASLEEP;
  }

  private ensureExistingReady(requireFrontendAuth: boolean): Promise<void> {
    this.requireRunning();
    // Joining an independently admitted startup is safe once the process is running.
    // While it is still stopped, the guard above refuses without waiting for that startup.
    if (this.starting !== undefined) return this.starting;
    if (this.ready) return this.activityProtocol && (!requireFrontendAuth || this.frontendAuthProtocol) ? Promise.resolve() : this.checkProtocols();
    // Keep no-start readiness separate: a pending attachment for an old process must not
    // prevent a newly admitted request from taking the normal wake path after it stops.
    this.existingReadiness ??= within(STARTUP_TIMEOUT_MS, async (signal) => {
      this.effectiveIdleTimeout();
      await this.options.attach();
      signal.throwIfAborted();
      this.requireRunning();
      await this.waitUntilReady(signal, true);
    }).finally(() => {
      this.existingReadiness = undefined;
    });
    return this.existingReadiness;
  }

  private checkProtocols(parent?: AbortSignal): Promise<void> {
    if (this.capabilityCheck !== undefined) return this.capabilityCheck;
    const incarnation = this.incarnation;
    const check = within(PROBE_TIMEOUT_MS, async (signal) => {
      const response = await this.container.getTcpPort(PORT).fetch(new Request("http://container/__sub2api/lifecycle", { signal }));
      return readProtocols(response, signal);
    }, parent).then((supported) => {
      if (incarnation === this.incarnation) {
        this.activityProtocol = supported.activity;
        this.frontendAuthProtocol = supported.frontendAuth;
        this.initializationProtocol = supported.initialization;
        this.initializationReady = supported.initializationReady;
      }
    }, () => {
      // A missing or unreachable marker cannot prove frontend authentication is fail-closed.
      // Missing initialization support must also fail closed before provider forwarding.
      if (incarnation === this.incarnation) {
        this.frontendAuthProtocol = false;
        this.initializationProtocol = false;
        this.initializationReady = false;
      }
    }).finally(() => {
      if (this.capabilityCheck === check) this.capabilityCheck = undefined;
    });
    this.capabilityCheck = check;
    return check;
  }

  private async startAndWait(signal: AbortSignal): Promise<void> {
    this.effectiveIdleTimeout();
    // Prepare imports once. Allocation retries must not consume first-boot configuration
    // again, change credentials, destroy a pending instance, or replay a provider request.
    let environment: Record<string, string> | undefined;
    const delays = [250, 500, 1000, 2000, 2000];
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      if (!this.container.running && environment === undefined) {
        this.foreground.clear();
        this.incarnation += 1;
        this.activityProtocol = false;
        this.frontendAuthProtocol = false;
        this.initializationProtocol = false;
        this.initializationReady = false;
        this.capabilityCheck = undefined;
        await this.options.beforeStart?.();
        signal.throwIfAborted();
        environment = await this.options.environment();
        signal.throwIfAborted();
      }
      // Connector/import failures are not allocator failures and must fail immediately.
      await this.options.attach();
      signal.throwIfAborted();
      try {
        if (!this.container.running) {
          // It may have stopped while attaching; prepare its environment next iteration.
          if (environment === undefined) continue;
          // Never destroy an allocation; start again only when the platform reports not running.
          this.container.start({ env: environment, enableInternet: true });
        }
        // start() can return before allocation finishes. Its async setup operation can
        // surface the same transient platform allocation error as start() itself.
        await this.applyInactivityTimeout(true);
        signal.throwIfAborted();
        break;
      } catch (error) {
        signal.throwIfAborted();
        const unavailable = error instanceof Error && error.message ===
          "There is no container instance that can be provided to this Durable Object, try again later";
        if (!unavailable || attempt >= delays.length) throw error;
        console.warn({ event: "container_allocation_retry", attempt: attempt + 1, delay_ms: delays[attempt] });
        await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
    await this.waitUntilReady(signal, false, true);
  }

  private async waitUntilReady(signal: AbortSignal, existingOnly = false, timeoutApplied = false): Promise<void> {
    if (existingOnly) this.requireRunning();
    if (!timeoutApplied) await this.applyInactivityTimeout(true);
    if (existingOnly) this.requireRunning();
    const port = this.container.getTcpPort(PORT);
    for (;;) {
      signal.throwIfAborted();
      if (existingOnly) this.requireRunning();
      try {
        const response = await within(PROBE_TIMEOUT_MS, (probeSignal) => port.fetch(new Request("http://container/healthz", { signal: probeSignal })), signal);
        await response.body?.cancel();
        signal.throwIfAborted();
        if (existingOnly) this.requireRunning();
        if (response.ok) {
          await this.checkProtocols(signal);
          signal.throwIfAborted();
          if (existingOnly) this.requireRunning();
          // Listening health is not provider readiness. The image explicitly confirms
          // configuration, account and model initialization, including valid empty sets.
          if (!this.initializationProtocol) throw INITIALIZATION_UNSUPPORTED;
          if (this.initializationReady) {
            await this.applyInactivityTimeout();
            if (existingOnly) this.requireRunning();
            this.ready = true;
            return;
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error === RUNTIME_ASLEEP || error === INITIALIZATION_UNSUPPORTED) throw error;
        if (existingOnly) this.requireRunning();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
  }
}
