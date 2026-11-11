export type BackgroundAction = "begin" | "renew" | "end";

export interface ActivityStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const STORAGE_KEY = "sub2api:background-activity:v1";
const LEASE_MS = 90_000;
const MAX_LIFETIME_MS = 15 * 60_000;
const MAX_JOBS = 256;
const validId = (id: string): boolean => /^[a-f0-9]{32}$/.test(id);

interface Job {
  readonly until: number;
  readonly maximum: number;
}

interface StoredActivity {
  readonly version: 1;
  readonly jobs: Array<[string, Job]>;
}

// Actual provider background work owns these short leases. There is no timer or request
// from the Worker while idle; the provider renews only while a guarded operation exists.
export class BackgroundActivity {
  private jobs = new Map<string, Job>();
  private queue: Promise<void> = Promise.resolve();
  private readonly storage: ActivityStorage;
  private readonly nowMs: () => number;

  constructor(storage: ActivityStorage, nowMs: () => number = Date.now) {
    this.storage = storage;
    this.nowMs = nowMs;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  restore(): Promise<void> {
    return this.serialize(async () => {
      const stored = await this.storage.get<StoredActivity>(STORAGE_KEY);
      if (stored === undefined) return;
      if (stored.version !== 1 || !Array.isArray(stored.jobs) || stored.jobs.length > MAX_JOBS) {
        throw new Error("Invalid persisted background activity");
      }
      const restored = new Map<string, Job>();
      for (const [id, job] of stored.jobs) {
        if (!validId(id) || !Number.isSafeInteger(job?.until) || !Number.isSafeInteger(job?.maximum) || job.until > job.maximum) {
          throw new Error("Invalid persisted background activity");
        }
        if (job.until > this.nowMs()) restored.set(id, job);
      }
      this.jobs = restored;
    });
  }

  remainingMs(): number {
    const now = this.nowMs();
    let remaining = 0;
    for (const [id, job] of this.jobs) {
      if (job.until <= now) this.jobs.delete(id);
      else remaining = Math.max(remaining, job.until - now);
    }
    return remaining;
  }

  update(action: BackgroundAction, id: string): Promise<boolean> {
    return this.serialize(async () => {
      if (!validId(id)) return false;
      this.remainingMs();
      const now = this.nowMs();
      const job = this.jobs.get(id);
      if (action === "begin") {
        if (job !== undefined || this.jobs.size >= MAX_JOBS) return false;
        this.jobs.set(id, { until: now + LEASE_MS, maximum: now + MAX_LIFETIME_MS });
      } else if (action === "renew") {
        if (job === undefined || job.maximum <= now) return false;
        this.jobs.set(id, { until: Math.min(now + LEASE_MS, job.maximum), maximum: job.maximum });
      } else if (action === "end") {
        this.jobs.delete(id);
      } else {
        return false;
      }
      // A grant is acknowledged only after persistence. A failed write retains a conservative
      // in-memory hold, but the provider must not start work without the successful response.
      await this.persist();
      return true;
    });
  }

  clear(): Promise<void> {
    return this.serialize(async () => {
      await this.storage.delete(STORAGE_KEY);
      this.jobs.clear();
    });
  }

  private async persist(): Promise<void> {
    if (this.jobs.size === 0) await this.storage.delete(STORAGE_KEY);
    else await this.storage.put<StoredActivity>(STORAGE_KEY, { version: 1, jobs: [...this.jobs] });
  }
}

export async function handleBackgroundActivity(request: Request, update: (action: BackgroundAction, id: string) => Promise<boolean>): Promise<Response> {
  const url = new URL(request.url);
  const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  if (url.protocol !== "http:" || url.host !== "r2.internal" || url.username || url.password || url.pathname !== "/__sub2api/activity" || url.search) return reply(404);
  const host = request.headers.get("host")?.toLowerCase();
  if (host !== undefined && host !== "r2.internal" && host !== "r2.internal:80") return reply(404);
  if (request.method !== "POST") return reply(405);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return reply(415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1024)) return reply(413);
  const reader = request.body?.getReader();
  if (!reader) return reply(400);
  let body: unknown;
  try {
    const bytes = new Uint8Array(1024);
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.byteLength) {
        void reader.cancel().catch(() => {});
        return reply(413);
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch {
    return reply(400);
  } finally {
    reader.releaseLock();
  }
  if (body === null || typeof body !== "object" || !("action" in body) || !("id" in body)) return reply(400);
  const { action, id } = body;
  if ((action !== "begin" && action !== "renew" && action !== "end") || typeof id !== "string" || !validId(id)) return reply(400);
  try {
    return reply(await update(action, id) ? 204 : 409);
  } catch {
    return reply(503);
  }
}
