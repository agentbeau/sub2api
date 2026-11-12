import type { OAuthLeaseStorage } from "./oauth-lease.ts";

const STORAGE_KEY = "sub2api:realtime-credential-idle:v1";
const MAX_JSON_BYTES = 512 * 1024;
const MAX_LIFETIME_MS = 2 * 60 * 60_000;
const ROUNDING_MARGIN_MS = 1000;
const MAX_HOLD_MS = MAX_LIFETIME_MS + ROUNDING_MARGIN_MS;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// CPA accepts at most 64KiB of session input, but JSON escaping can expand it sixfold.
// Clone only the two credential-creation responses, leaving their original bytes intact.
async function credentialJson(response: Response): Promise<Record<string, unknown> | null> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_JSON_BYTES) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (reader === undefined) return null;
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
    // A tee's cancellation may wait for the untouched original response; never await it.
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

// CPA keeps minted ek_ credentials in process memory and permits repeated use until expiry.
// Persist only their latest absolute deadline, never a credential or its session contents.
export class RealtimeLease {
  private until = 0;
  private generation = 0;
  private dirty = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: OAuthLeaseStorage, private readonly nowMs = Date.now) {}

  restore(): Promise<void> {
    return this.serialize(async () => {
      const saved = await this.storage.get<unknown>(STORAGE_KEY);
      const now = this.nowMs();
      this.until = typeof saved === "number" && Number.isSafeInteger(saved) && saved > now && saved <= now + MAX_HOLD_MS ? saved : 0;
      this.dirty = false;
      if (this.until === 0) await this.storage.delete(STORAGE_KEY);
    });
  }

  remainingMs(): number {
    return Math.max(0, this.until - this.nowMs());
  }

  // Call only before a confirmed cold start. Object eviction with a live process restores
  // the hold, and using or disconnecting a credential cannot release its remaining lifetime.
  clear(): Promise<void> {
    this.generation += 1;
    return this.serialize(async () => {
      this.until = 0;
      this.dirty = false;
      await this.storage.delete(STORAGE_KEY);
    });
  }

  async observe(request: Request, response: Response): Promise<boolean> {
    // Cpa calls this after gateway admission and the provider's own authentication succeeds.
    // Do not duplicate header authentication: configured plugins may use other credentials.
    if (request.method !== "POST" || !response.ok) return false;
    const path = new URL(request.url).pathname;
    if (path !== "/v1/realtime/client_secrets" && path !== "/v1/realtime/sessions") return false;
    const generation = this.generation;
    const observedAt = this.nowMs();
    const body = await credentialJson(response);
    const credential = path === "/v1/realtime/sessions" ? record(body?.client_secret) : body;
    if (typeof credential?.value !== "string" || !credential.value.startsWith("ek_") || credential.value.length <= 3) return false;
    const seconds = credential.expires_at;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds)) return false;
    // CPA returns expiresAt.Unix(), truncating the fractional second of the real expiry.
    const absolute = seconds * 1000 + ROUNDING_MARGIN_MS;
    if (!Number.isSafeInteger(absolute)) return false;
    const until = Math.min(absolute, observedAt + MAX_HOLD_MS);
    return this.serialize(async () => {
      if (generation !== this.generation || until <= this.nowMs()) return false;
      const changed = until > this.until;
      if (changed) {
        this.until = until;
        this.dirty = true;
      }
      // Update memory before persistence so lifecycle finally handling retains the hold even
      // if storage fails. A later successful creation observation retries the same deadline.
      if (this.dirty) {
        await this.storage.put(STORAGE_KEY, this.until);
        this.dirty = false;
      }
      return changed;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    return result;
  }
}
