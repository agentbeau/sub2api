export interface OAuthLeaseStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const STORAGE_KEY = "sub2api:oauth-idle-leases:v1";
const MAX_JSON_BYTES = 16_384;
const CALLBACK_WINDOW_MS = 5 * 60_000;
const DEVICE_WINDOW_MS = 30 * 60_000;
const COMPLETION_BUFFER_MS = 60_000;
const MAX_FLOW_MS = DEVICE_WINDOW_MS + COMPLETION_BUFFER_MS;
const PERSISTENCE_GRACE_MS = 35_000;

const LEGACY_STARTS = new Set([
  "/v0/management/anthropic-auth-url",
  "/v0/management/codex-auth-url",
  "/v0/management/antigravity-auth-url",
  "/v0/management/kimi-auth-url",
  "/v0/management/kimi-ai-auth-url",
  "/v0/management/xai-auth-url",
  "/v0/management/devin-auth-url",
  "/v0/management/meta-auth-url",
]);

type Observation = "start" | "status" | "cancel" | null;

function observation(path: string, method: string): Observation {
  if ((method === "GET" && LEGACY_STARTS.has(path))
    || ((method === "GET" || method === "POST") && path === "/v8/management/oauth/auth-url")
    || (method === "POST" && path === "/v8/management/oauth/siwc/bind")) return "start";
  if (method === "GET" && (path === "/v0/management/get-auth-status" || path === "/v8/management/oauth/status")) return "status";
  if (method === "DELETE" && (path === "/v0/management/oauth-session" || path === "/v8/management/oauth/session")) return "cancel";
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stateId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const state = value.trim();
  return /^[A-Za-z0-9_.-]{1,128}$/.test(state) && !state.includes("..") ? state : null;
}

const CALLBACK_PROVIDERS = new Set(["anthropic", "claude", "codex", "antigravity", "devin"]);

function flowDuration(body: Record<string, unknown>, url: URL, method: string): number {
  const expires = body.expires_in;
  if (typeof expires === "number" && Number.isFinite(expires) && expires > 0) {
    return Math.min(MAX_FLOW_MS, Math.ceil(expires * 1000) + COMPLETION_BUFFER_MS);
  }
  const provider = url.pathname.startsWith("/v0/management/")
    ? url.pathname.slice("/v0/management/".length, -"-auth-url".length)
    : method === "GET" ? url.searchParams.get("provider")?.trim().toLowerCase() : undefined;
  const knownCallback = body.flow === "siwc_bind" || url.pathname === "/v8/management/oauth/siwc/bind"
    || (provider !== undefined && CALLBACK_PROVIDERS.has(provider));
  // Plugin starts can omit both flow and expiry while CPA keeps their state for 30 minutes.
  // A v8 POST's provider may live in its already-forwarded body; never consume that body here.
  return (body.flow === "device" || !knownCallback ? DEVICE_WINDOW_MS : CALLBACK_WINDOW_MS) + COMPLETION_BUFFER_MS;
}

// Only exact OAuth control responses are cloned. Bound the bytes even when CPA
// omits Content-Length, and never wait for a tee cancellation before returning
// the original response to its consumer.
async function smallJson(response: Response): Promise<Record<string, unknown> | null> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_JSON_BYTES) return null;
  const reader = response.clone().body?.getReader();
  if (reader === undefined) return null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_JSON_BYTES - size) return null;
      size += value.byteLength;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return record(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

interface SavedLeases {
  states: [string, number][];
  mutationUntil: number;
}

// These are inactivity holds, not copies of CPA's OAuth sessions. CPA remains
// authoritative for authentication and token exchange. Only opaque state IDs
// and absolute deadlines are stored; no provider URLs, codes or credentials.
export class OAuthLease {
  private readonly states = new Map<string, number>();
  private mutationUntil = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private dirty = false;

  constructor(private readonly storage: OAuthLeaseStorage, private readonly nowMs = Date.now) {}

  restore(): Promise<void> {
    return this.serialize(async () => {
      const saved = record(await this.storage.get<unknown>(STORAGE_KEY));
      this.states.clear();
      this.mutationUntil = 0;
      if (saved === null) return;
      const now = this.nowMs();
      if (Array.isArray(saved.states)) {
        for (const item of saved.states as unknown[]) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [rawState, expiresAt] = item as unknown[];
          const state = stateId(rawState);
          if (state !== null && validDeadline(expiresAt, now, MAX_FLOW_MS)) this.states.set(state, expiresAt);
        }
      }
      if (validDeadline(saved.mutationUntil, now, PERSISTENCE_GRACE_MS)) this.mutationUntil = saved.mutationUntil;
      // Clean only our isolated record; this cannot touch provider/import state.
      this.dirty = true;
      await this.save();
    });
  }

  remainingMs(): number {
    let until = this.mutationUntil;
    for (const expiresAt of this.states.values()) until = Math.max(until, expiresAt);
    return Math.max(0, until - this.nowMs());
  }

  // Call only before a confirmed cold start: the old process's OAuth sessions and
  // local pending writes are gone. DO eviction with a running process must restore them.
  clear(): Promise<void> {
    return this.serialize(async () => {
      await this.storage.delete(STORAGE_KEY);
      this.states.clear();
      this.mutationUntil = 0;
      this.dirty = false;
    });
  }

  async observe(request: Request, response: Response): Promise<boolean> {
    // Call only after the Rust dashboard gate and CPA forwarding. Successful
    // management auth uses either of these headers; anonymous/failed replies
    // and provider inference streams never create or update a lease.
    if (!response.ok || !(request.headers.get("authorization")?.trim() || request.headers.get("x-management-key")?.trim())) return false;
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v0/management/") && !url.pathname.startsWith("/v8/management/")) return false;
    const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
    const kind = observation(url.pathname, request.method);
    if (kind === null && !mutation) return false;
    const observedAt = this.nowMs();
    const body = kind === null ? null : await smallJson(response);
    return this.serialize(async () => {
      let changed = this.expire(observedAt);
      if (mutation) changed = this.reservePersistence(observedAt) || changed;
      if (kind === "start" && body?.status === "ok") {
        const state = stateId(body.state);
        if (state !== null && !this.states.has(state)) {
          this.states.set(state, observedAt + flowDuration(body, url, request.method));
          changed = true;
        }
      } else if ((kind === "status" && (body?.status === "ok" || body?.status === "error"))
        || (kind === "cancel" && body?.status === "ok" && body.cancelled === true)) {
        const state = stateId(url.searchParams.get("state"));
        if (state !== null && this.states.delete(state)) {
          // A repeated terminal status does not slide this deadline. A rejected
          // cancel (cancelled:false) can mean an exchange is still committing.
          this.reservePersistence(observedAt);
          changed = true;
        }
      }
      this.dirty ||= changed;
      // Update memory before awaiting storage so the lifecycle can retain the
      // hold even if durable persistence fails and this observation rejects.
      if (this.dirty) await this.save();
      return changed;
    });
  }

  private reservePersistence(now: number): boolean {
    const until = Math.max(this.mutationUntil, now + PERSISTENCE_GRACE_MS);
    if (until === this.mutationUntil) return false;
    this.mutationUntil = until;
    return true;
  }

  private expire(now: number): boolean {
    let changed = false;
    for (const [state, expiresAt] of this.states) {
      if (expiresAt <= now) { this.states.delete(state); changed = true; }
    }
    if (this.mutationUntil !== 0 && this.mutationUntil <= now) {
      this.mutationUntil = 0;
      changed = true;
    }
    return changed;
  }

  private async save(): Promise<void> {
    if (this.states.size === 0 && this.mutationUntil === 0) await this.storage.delete(STORAGE_KEY);
    else {
      const saved: SavedLeases = { states: Array.from(this.states), mutationUntil: this.mutationUntil };
      await this.storage.put(STORAGE_KEY, saved);
    }
    this.dirty = false;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    return result;
  }
}

function validDeadline(value: unknown, now: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > now && value <= now + maximum;
}
