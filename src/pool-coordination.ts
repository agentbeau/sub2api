// Durable, fenced coordination primitives for a future container pool. These are
// deliberately not wired into request routing or CPA refreshes yet; the live
// deployment remains a singleton until the Go refresh and R2 write paths use them.
export interface PoolTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface PoolStorage extends PoolTransaction {
  transaction<T>(callback: (txn: PoolTransaction) => Promise<T>): Promise<T>;
}

export interface FencedLease {
  readonly resource: string;
  readonly owner: string;
  readonly epoch: number;
  readonly expiresAt: number;
}

interface SavedLease { readonly epoch: number; readonly owner: string; readonly expiresAt: number }
interface SavedState { readonly resource: string; readonly fence: number; readonly version: number; readonly value: unknown }
interface SavedOAuthOwner { readonly shard: number; readonly expiresAt: number }

const LEASE_PREFIX = "pool:lease:v1:";
const STATE_PREFIX = "pool:state:v1:";
const OAUTH_PREFIX = "pool:oauth:v1:";
const MAX_LEASE_MS = 5 * 60_000;
const MAX_OAUTH_MS = 31 * 60_000;

function safeId(value: string, max = 160): boolean {
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function validLease(value: unknown): value is SavedLease {
  if (typeof value !== "object" || value === null) return false;
  const lease = value as Partial<SavedLease>;
  return typeof lease.epoch === "number" && Number.isSafeInteger(lease.epoch) && lease.epoch > 0
    && typeof lease.owner === "string" && (lease.owner === "" || safeId(lease.owner))
    && typeof lease.expiresAt === "number" && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt >= 0;
}

// Non-cryptographic stable placement only. Never use this as an auth decision or
// as proof that a request belongs to a provider credential.
export function sessionShard(sessionId: string, shardCount: number): number {
  if (!safeId(sessionId, 1024) || !Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 16) {
    throw new RangeError("Invalid session shard input");
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index++) {
    hash = Math.imul(hash ^ sessionId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

export class PoolCoordinator {
  constructor(private readonly storage: PoolStorage) {}

  async claimRefresh(resource: string, owner: string, now: number, leaseMs: number): Promise<FencedLease | undefined> {
    this.validateLeaseInput(resource, owner, now, leaseMs);
    return this.storage.transaction(async txn => {
      const key = LEASE_PREFIX + resource;
      const old = await txn.get<unknown>(key);
      if (old !== undefined && !validLease(old)) throw new Error("Invalid persisted pool lease");
      if (old !== undefined && old.expiresAt > now && old.owner !== owner) return undefined;
      const epoch = old === undefined ? 1 : old.epoch + (old.owner === owner && old.expiresAt > now ? 0 : 1);
      const saved: SavedLease = { epoch, owner, expiresAt: now + leaseMs };
      await txn.put(key, saved);
      return { resource, ...saved };
    });
  }

  async release(lease: FencedLease, now: number): Promise<boolean> {
    this.validateLease(lease, now);
    return this.storage.transaction(async txn => {
      const key = LEASE_PREFIX + lease.resource;
      const current = await txn.get<unknown>(key);
      if (!validLease(current) || current.owner !== lease.owner || current.epoch !== lease.epoch || current.expiresAt <= now) return false;
      // Retain the epoch as a tombstone so a later acquisition cannot reuse it.
      await txn.put(key, { epoch: current.epoch, owner: "", expiresAt: now } satisfies SavedLease);
      return true;
    });
  }

  async bindOAuthState(state: string, shard: number, now: number, ttlMs: number): Promise<boolean> {
    if (!safeId(state, 128) || !Number.isSafeInteger(shard) || shard < 0 || shard > 15
      || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_OAUTH_MS) {
      throw new RangeError("Invalid OAuth ownership input");
    }
    return this.storage.transaction(async txn => {
      const key = OAUTH_PREFIX + state;
      const current = await txn.get<unknown>(key);
      if (typeof current === "object" && current !== null) {
        const old = current as Partial<SavedOAuthOwner>;
        if (typeof old.expiresAt !== "number" || !Number.isSafeInteger(old.expiresAt)
          || typeof old.shard !== "number" || !Number.isSafeInteger(old.shard)) throw new Error("Invalid persisted OAuth owner");
        if (old.expiresAt > now && old.shard !== shard) return false;
      }
      await txn.put(key, { shard, expiresAt: now + ttlMs } satisfies SavedOAuthOwner);
      return true;
    });
  }

  async callbackShard(state: string, now: number): Promise<number | undefined> {
    if (!safeId(state, 128) || !Number.isSafeInteger(now) || now < 0) return undefined;
    return this.storage.transaction(async txn => {
      const key = OAUTH_PREFIX + state;
      const saved = await txn.get<unknown>(key);
      if (typeof saved !== "object" || saved === null) return undefined;
      const owner = saved as Partial<SavedOAuthOwner>;
      if (typeof owner.shard !== "number" || !Number.isSafeInteger(owner.shard) || owner.shard < 0 || owner.shard > 15
        || typeof owner.expiresAt !== "number" || !Number.isSafeInteger(owner.expiresAt)) throw new Error("Invalid persisted OAuth owner");
      if (owner.expiresAt <= now) {
        await txn.delete(key);
        return undefined;
      }
      return owner.shard;
    });
  }

  async writeShared<T>(lease: FencedLease, object: string, expectedVersion: number, value: T, now: number): Promise<{ok: true; version: number} | {ok: false; reason: "stale_owner" | "conflict"}> {
    this.validateLease(lease, now);
    if (!safeId(object, 256) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new RangeError("Invalid shared state write");
    return this.storage.transaction(async txn => {
      const savedLease = await txn.get<unknown>(LEASE_PREFIX + lease.resource);
      if (!validLease(savedLease) || savedLease.owner !== lease.owner || savedLease.epoch !== lease.epoch || savedLease.expiresAt <= now) {
        return { ok: false, reason: "stale_owner" } as const;
      }
      const key = STATE_PREFIX + object;
      const previous = await txn.get<unknown>(key);
      let version = 0;
      if (previous !== undefined) {
        if (typeof previous !== "object" || previous === null) throw new Error("Invalid persisted shared state");
        const record = previous as Partial<SavedState>;
        if (record.resource !== lease.resource || typeof record.fence !== "number" || !Number.isSafeInteger(record.fence)
          || typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 1) {
          throw new Error("Invalid persisted shared state");
        }
        version = record.version;
      }
      if (version !== expectedVersion) return { ok: false, reason: "conflict" } as const;
      const next = version + 1;
      await txn.put(key, { resource: lease.resource, fence: lease.epoch, version: next, value } satisfies SavedState);
      return { ok: true, version: next } as const;
    });
  }

  async readShared<T>(object: string): Promise<{version: number; fence: number; value: T} | undefined> {
    if (!safeId(object, 256)) return undefined;
    const saved = await this.storage.get<unknown>(STATE_PREFIX + object);
    if (typeof saved !== "object" || saved === null) return undefined;
    const record = saved as Partial<SavedState>;
    if (typeof record.version !== "number" || !Number.isSafeInteger(record.version)
      || typeof record.fence !== "number" || !Number.isSafeInteger(record.fence) || typeof record.resource !== "string") {
      throw new Error("Invalid persisted shared state");
    }
    return { version: record.version, fence: record.fence, value: record.value as T };
  }

  private validateLeaseInput(resource: string, owner: string, now: number, leaseMs: number): void {
    if (!safeId(resource) || !safeId(owner) || !Number.isSafeInteger(now) || now < 0
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > MAX_LEASE_MS) throw new RangeError("Invalid pool lease input");
  }

  private validateLease(lease: FencedLease, now: number): void {
    if (!safeId(lease.resource) || !safeId(lease.owner) || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
      || !Number.isSafeInteger(lease.expiresAt) || !Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid fenced lease");
  }
}
