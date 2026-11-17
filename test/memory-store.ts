import type { ObjectStore, StoredBody, StoredObject } from "../src/s3.ts";

interface Entry {
  readonly bytes: Uint8Array;
  readonly meta: StoredObject;
}

export class MemoryStore implements ObjectStore {
  readonly entries = new Map<string, Entry>();
  private version = 0;

  async head(key: string): Promise<StoredObject | null> {
    return this.entries.get(key)?.meta ?? null;
  }

  async get(key: string): Promise<StoredBody | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    return { ...entry.meta, arrayBuffer: async () => entry.bytes.slice().buffer };
  }

  async put(key: string, value: ArrayBuffer, options?: { onlyIf?: Headers }): Promise<StoredObject | null> {
    const current = this.entries.get(key)?.meta;
    const ifMatch = options?.onlyIf?.get("if-match");
    const ifNoneMatch = options?.onlyIf?.get("if-none-match");
    const matches = (condition: string, etag: string): boolean => condition.trim() === "*"
      || condition.split(",").some((candidate) => candidate.trim() === `"${etag}"` || candidate.trim() === etag);
    if (ifMatch !== null && ifMatch !== undefined && (current === undefined || !matches(ifMatch, current.etag))) return null;
    if (ifNoneMatch !== null && ifNoneMatch !== undefined && current !== undefined && matches(ifNoneMatch, current.etag)) return null;
    this.version += 1;
    const bytes = new Uint8Array(value.slice(0));
    const meta = { key, size: bytes.length, etag: `etag-${this.version}`, uploaded: new Date(Date.UTC(2026, 9, 12, 0, 0, this.version)) };
    this.entries.set(key, { bytes, meta });
    return meta;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(options: { prefix: string; cursor?: string; limit: number }): Promise<{ objects: StoredObject[]; truncated: boolean; cursor?: string }> {
    const keys = [...this.entries.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const page = keys.slice(start, start + options.limit);
    const end = start + page.length;
    const objects = page.map((key) => this.entries.get(key)?.meta).filter((meta): meta is StoredObject => meta !== undefined);
    return end < keys.length ? { objects, truncated: true, cursor: String(end) } : { objects, truncated: false };
  }

  text(key: string): string | null {
    const entry = this.entries.get(key);
    return entry === undefined ? null : new TextDecoder().decode(entry.bytes);
  }
}
