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

const PORT = 8317;
const STARTUP_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1000;
const PROBE_INTERVAL_MS = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 1000;
const MAX_IDLE_TIMEOUT_MS = 21_600_000;
const LEGACY_IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_CAPABILITY_BYTES = 1024;

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

async function supportsActivityProtocol(response: Response, signal: AbortSignal): Promise<boolean> {
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {});
    return false;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const bytes = new Uint8Array(MAX_CAPABILITY_BYTES);
    let length = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) return false;
      bytes.set(value, length);
      length += value.byteLength;
    }
    signal.throwIfAborted();
    const marker: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    return typeof marker === "object" && marker !== null && "activity_protocol" in marker && marker.activity_protocol === 1;
  } catch {
    return false;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export class ContainerLifecycle {
  private starting: Promise<void> | undefined;
  private ready = false;
  private baseIdleTimeout: number | undefined;
  private appliedIdleTimeout: number | undefined;
  private timeoutUpdate: Promise<void> | undefined;
  private activityProtocol = false;
  private capabilityCheck: Promise<void> | undefined;
  private incarnation = 0;

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
    if (options.detectProtocol && !this.activityProtocol) await this.checkActivityProtocol();
    if (this.container.running) await this.applyInactivityTimeout();
  }

  async forward(request: Request): Promise<Response> {
    try {
      request.signal.throwIfAborted();
      await this.ensureReady();
      await this.applyInactivityTimeout();
      request.signal.throwIfAborted();
      const url = new URL(request.url);
      url.protocol = "http:";
      url.host = "container";
      const forwarded = new Request(url, request);
      forwarded.headers.delete("host");
      const response = await this.container.getTcpPort(PORT).fetch(forwarded);
      try {
        // The lease inspects only bounded management JSON. Inference streams and upgrade
        // responses pass through untouched, without cloning, buffering or retrying them.
        await this.options.lease?.observe(request, response);
      } finally {
        // Preserve the in-memory hold even if persisting it failed. Recompute from absolute
        // deadlines so unrelated requests and status polling cannot renew an OAuth lease.
        await this.applyInactivityTimeout();
      }
      return response;
    } catch {
      this.ready = false;
      return containerUnavailable();
    }
  }

  private effectiveIdleTimeout(): number {
    this.baseIdleTimeout ??= containerIdleTimeout(this.options.idleTimeout);
    // Worker code is deployed before the default-policy image rollout completes. An old
    // process cannot notify us about background work, so retain its prior idle allowance.
    return Math.max(this.baseIdleTimeout, this.activityProtocol ? 0 : LEGACY_IDLE_TIMEOUT_MS, Math.ceil(this.options.lease?.remainingMs() ?? 0));
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

  private ensureReady(): Promise<void> {
    if (this.ready && this.container.running) {
      // Retry only on an actual forwarded request while an old image remains in service.
      // A supported process needs no additional capability requests or polling timer.
      return this.activityProtocol ? Promise.resolve() : this.checkActivityProtocol();
    }
    this.ready = false;
    this.starting ??= within(STARTUP_TIMEOUT_MS, (signal) => this.startAndWait(signal)).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private checkActivityProtocol(parent?: AbortSignal): Promise<void> {
    if (this.capabilityCheck !== undefined) return this.capabilityCheck;
    const incarnation = this.incarnation;
    const check = within(PROBE_TIMEOUT_MS, async (signal) => {
      const response = await this.container.getTcpPort(PORT).fetch(new Request("http://container/__sub2api/lifecycle", { signal }));
      return supportsActivityProtocol(response, signal);
    }, parent).then((supported) => {
      if (incarnation === this.incarnation) this.activityProtocol = supported;
    }, () => {
      // Missing, malformed and unreachable markers keep the conservative timeout. A healthy
      // older provider image must continue serving models during a mixed deployment.
    }).finally(() => {
      if (this.capabilityCheck === check) this.capabilityCheck = undefined;
    });
    this.capabilityCheck = check;
    return check;
  }

  private async startAndWait(signal: AbortSignal): Promise<void> {
    this.effectiveIdleTimeout();
    if (!this.container.running) {
      this.incarnation += 1;
      this.activityProtocol = false;
      this.capabilityCheck = undefined;
      // The prior process is gone, so its background jobs cannot still be running.
      await this.options.beforeStart?.();
      signal.throwIfAborted();
      const environment = await this.options.environment();
      signal.throwIfAborted();
      await this.options.attach();
      signal.throwIfAborted();
      // The existing default scheduler still selects the configured image/basic instance.
      this.container.start({ env: environment, enableInternet: true });
    } else {
      await this.options.attach();
      signal.throwIfAborted();
    }
    await this.applyInactivityTimeout(true);
    const port = this.container.getTcpPort(PORT);
    for (;;) {
      signal.throwIfAborted();
      try {
        const response = await within(PROBE_TIMEOUT_MS, (probeSignal) => port.fetch(new Request("http://container/healthz", { signal: probeSignal })), signal);
        await response.body?.cancel();
        signal.throwIfAborted();
        if (response.ok) {
          await this.checkActivityProtocol(signal);
          signal.throwIfAborted();
          await this.applyInactivityTimeout();
          this.ready = true;
          return;
        }
      } catch {
        signal.throwIfAborted();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
  }
}
