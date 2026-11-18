// Durable, fenced coordination for OAuth ownership, refresh jobs, and shared writes.
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
interface SavedOAuthOwner { readonly shard?: number; readonly owner?: string; readonly expiresAt: number }
interface SavedSessionAffinity { readonly authId: string; readonly owner: string; readonly version: number; readonly expiresAt: number }

export interface SessionAffinityRecord {
  readonly authId: string;
  readonly owner: string;
  readonly version: number;
  readonly expiresAt: number;
}

const LEASE_PREFIX = "pool:lease:v1:";
const STATE_PREFIX = "pool:state:v1:";
const OAUTH_PREFIX = "pool:oauth:v1:";
const AFFINITY_PREFIX = "pool:affinity:v1:";
const MAX_LEASE_MS = 5 * 60_000;
const MAX_OAUTH_MS = 31 * 60_000;
const MAX_AFFINITY_MS = 24 * 60 * 60_000;

function safeId(value: string, max = 160): boolean {
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function validSessionId(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validLease(value: unknown): value is SavedLease {
  if (typeof value !== "object" || value === null) return false;
  const lease = value as Partial<SavedLease>;
  return typeof lease.epoch === "number" && Number.isSafeInteger(lease.epoch) && lease.epoch > 0
    && typeof lease.owner === "string" && (lease.owner === "" || safeId(lease.owner))
    && typeof lease.expiresAt === "number" && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt >= 0;
}

// Versioned, non-cryptographic stable placement only. Freeze this algorithm once
// pool routing is enabled; changing it would move existing conversations. Never
// use the result as an auth decision or proof that a request owns a credential.
export function sessionShard(sessionId: string, shardCount: number): number {
  if (!validSessionId(sessionId) || !Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 16) {
    throw new RangeError("Invalid session shard input");
  }
  let hash = 0x811c9dc5;
  const input = `sub2api-pool-session-v1\u0000${sessionId}`;
  for (let index = 0; index < input.length; index++) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

export class PoolCoordinator {
  private readonly resourceTails = new Map<string, Promise<void>>();

  constructor(private readonly storage: PoolStorage, private readonly clock: () => number = Date.now) {}

  async claimRefresh(resource: string, owner: string, leaseMs: number): Promise<FencedLease | undefined> {
    this.validateLeaseInput(resource, owner, leaseMs);
    return this.serializeResource(resource, () => this.storage.transaction(async txn => {
      const now = this.now();
      const key = LEASE_PREFIX + resource;
      const old = await txn.get<unknown>(key);
      if (old !== undefined && !validLease(old)) throw new Error("Invalid persisted pool lease");
      // A boot ID is shared by work in one process, so even the same owner cannot
      // reacquire an active lease and accidentally run two refreshes concurrently.
      if (old !== undefined && old.expiresAt > now) return undefined;
      const epoch = old === undefined ? 1 : old.epoch + 1;
      const saved: SavedLease = { epoch, owner, expiresAt: now + leaseMs };
      await txn.put(key, saved);
      return { resource, ...saved };
    }));
  }

  async renewRefresh(lease: FencedLease, leaseMs: number): Promise<FencedLease | undefined> {
    this.validateLease(lease);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > MAX_LEASE_MS) throw new RangeError("Invalid pool lease input");
    return this.serializeResource(lease.resource, () => this.storage.transaction(async txn => {
      const now = this.now();
      const key = LEASE_PREFIX + lease.resource;
      const current = await txn.get<unknown>(key);
      if (!validLease(current) || current.owner !== lease.owner || current.epoch !== lease.epoch || current.expiresAt <= now) return undefined;
      const renewed: SavedLease = { epoch: current.epoch, owner: current.owner, expiresAt: now + leaseMs };
      await txn.put(key, renewed);
      return { resource: lease.resource, ...renewed };
    }));
  }

  async currentLease(resource: string, owner: string, epoch: number): Promise<boolean> {
    if (!safeId(resource) || !safeId(owner) || !Number.isSafeInteger(epoch) || epoch < 1) return false;
    return this.serializeResource(resource, () => this.storage.transaction(async txn => {
      const lease = await txn.get<unknown>(LEASE_PREFIX + resource);
      return validLease(lease) && lease.owner === owner && lease.epoch === epoch && lease.expiresAt > this.now();
    }));
  }

  // Run the actual shared-store mutation under the same per-resource queue as
  // acquire/renew/release. A lease check followed by an unrelated R2 request has
  // a race window; keeping the binding write inside this queue prevents takeover
  // until that write has completed, while R2's ETag condition protects the object.
  async withCurrentLease<T>(resource: string, owner: string, epoch: number, operation: () => Promise<T>): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "stale_owner" }
  > {
    if (!safeId(resource) || !safeId(owner) || !Number.isSafeInteger(epoch) || epoch < 1) {
      throw new RangeError("Invalid fenced write input");
    }
    return this.serializeResource(resource, async () => {
      const current = await this.storage.transaction(async txn => {
        const saved = await txn.get<unknown>(LEASE_PREFIX + resource);
        return validLease(saved) && saved.owner === owner && saved.epoch === epoch && saved.expiresAt > this.now();
      });
      if (!current) return { ok: false, reason: "stale_owner" } as const;
      return { ok: true, value: await operation() } as const;
    });
  }

  async release(lease: FencedLease): Promise<boolean> {
    this.validateLease(lease);
    return this.serializeResource(lease.resource, () => this.storage.transaction(async txn => {
      const now = this.now();
      const key = LEASE_PREFIX + lease.resource;
      const current = await txn.get<unknown>(key);
      if (!validLease(current) || current.owner !== lease.owner || current.epoch !== lease.epoch || current.expiresAt <= now) return false;
      // Retain the epoch as a tombstone so a later acquisition cannot reuse it.
      await txn.put(key, { epoch: current.epoch, owner: "", expiresAt: now } satisfies SavedLease);
      return true;
    }));
  }

  async bindOAuthState(state: string, shard: number, ttlMs: number): Promise<boolean> {
    if (!safeId(state, 128) || !Number.isSafeInteger(shard) || shard < 0 || shard > 15
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_OAUTH_MS) {
      throw new RangeError("Invalid OAuth ownership input");
    }
    return this.storage.transaction(async txn => {
      const now = this.now();
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

  // Session affinity records contain credential identifiers, never credential
  // material. CPA hashes provider + explicit session + model before crossing
  // the internal bridge, so raw session identifiers stay inside the container.
  async readSessionAffinity(key: string, ownerId: string): Promise<SessionAffinityRecord> {
    this.validateAffinityKey(key);
    this.validateAffinityOwner(ownerId);
    return this.storage.transaction(async txn => {
      const raw = await txn.get<unknown>(AFFINITY_PREFIX + key);
      if (raw === undefined) return { authId: "", owner: "", version: 0, expiresAt: 0 };
      if (!this.validSessionAffinity(raw)) throw new Error("Invalid persisted session affinity");
      const record = raw as SavedSessionAffinity;
      if (record.version > 0 && record.owner !== ownerId) throw new Error("Session affinity owner mismatch");
      return record.expiresAt > this.now()
        ? record
        : { authId: "", owner: record.owner, version: record.version, expiresAt: record.expiresAt };
    });
  }

  // Each selected request consumes a fencing version, even if it keeps the
  // same credential. A different credential can replace a binding only at the
  // version observed before selection; losing the CAS fails closed before the
  // provider request is submitted.
  async bindSessionAffinity(
    key: string,
    expectedVersion: number,
    ownerId: string,
    authId: string,
    ttlMs: number,
  ): Promise<{ readonly ok: true; readonly record: SessionAffinityRecord } | { readonly ok: false; readonly record: SessionAffinityRecord }> {
    this.validateAffinityKey(key);
    this.validateAffinityOwner(ownerId);
    this.validateAffinityWrite(expectedVersion, authId, ttlMs);
    return this.storage.transaction(async txn => {
      const now = this.now();
      const storageKey = AFFINITY_PREFIX + key;
      const raw = await txn.get<unknown>(storageKey);
      if (raw !== undefined && !this.validSessionAffinity(raw)) throw new Error("Invalid persisted session affinity");
      const current = raw as SavedSessionAffinity | undefined;
      const currentVersion = current?.version ?? 0;
      const active = current !== undefined && current.expiresAt > now && current.authId !== "";
      if (current !== undefined && current.owner !== ownerId) {
        return { ok: false, record: { authId: "", owner: "", version: currentVersion, expiresAt: current.expiresAt } } as const;
      }
      if (currentVersion !== expectedVersion) {
        return { ok: false, record: current === undefined
          ? { authId: "", owner: "", version: 0, expiresAt: 0 }
          : active ? current : { authId: "", owner: current.owner, version: current.version, expiresAt: current.expiresAt } } as const;
      }
      // Every selected request gets a distinct version, even when it keeps the
      // same credential. The result callback carries this version so a late
      // failure cannot erase a newer in-flight request's affinity.
      if (currentVersion >= Number.MAX_SAFE_INTEGER) throw new Error("Session affinity version exhausted");
      const next = { authId, owner: ownerId, version: currentVersion + 1, expiresAt: now + ttlMs };
      await txn.put(storageKey, next);
      return { ok: true, record: next } as const;
    });
  }

  async deleteSessionAffinity(key: string, expectedVersion: number, ownerId: string, authId: string, ttlMs: number): Promise<boolean> {
    this.validateAffinityKey(key);
    this.validateAffinityOwner(ownerId);
    this.validateAffinityWrite(expectedVersion, authId, ttlMs);
    return this.storage.transaction(async txn => {
      const storageKey = AFFINITY_PREFIX + key;
      const raw = await txn.get<unknown>(storageKey);
      if (raw === undefined) return true;
      if (!this.validSessionAffinity(raw)) throw new Error("Invalid persisted session affinity");
      const current = raw as SavedSessionAffinity;
      if (current.owner !== ownerId || current.version !== expectedVersion || current.authId !== authId || current.expiresAt <= this.now()) return false;
      if (current.version >= Number.MAX_SAFE_INTEGER) throw new Error("Session affinity version exhausted");
      // Retain a versioned tombstone so a stale selection cannot resurrect an
      // older credential after a result-driven rebind.
      await txn.put(storageKey, { authId: "", owner: current.owner, version: current.version + 1, expiresAt: this.now() + ttlMs } satisfies SavedSessionAffinity);
      return true;
    });
  }

  async callbackShard(state: string): Promise<number | undefined> {
    if (!safeId(state, 128)) return undefined;
    return this.storage.transaction(async txn => {
      const now = this.now();
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

  async bindOAuthOwner(state: string, owner: string, ttlMs: number): Promise<boolean> {
    if (!safeId(state, 128) || !/^[a-f0-9]{64}$/.test(owner)
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_OAUTH_MS) {
      throw new RangeError("Invalid OAuth ownership input");
    }
    return this.storage.transaction(async txn => {
      const now = this.now();
      const key = OAUTH_PREFIX + state;
      const current = await txn.get<unknown>(key);
      if (typeof current === "object" && current !== null) {
        const old = current as Partial<SavedOAuthOwner>;
        if (typeof old.expiresAt !== "number" || !Number.isSafeInteger(old.expiresAt)
          || (old.owner !== undefined && typeof old.owner !== "string")) throw new Error("Invalid persisted OAuth owner");
        if (old.expiresAt > now && old.owner !== undefined && old.owner !== owner) return false;
      }
      await txn.put(key, { owner, expiresAt: now + ttlMs } satisfies SavedOAuthOwner);
      return true;
    });
  }

  // A callback is valid only for the live CPA process that created its PKCE
  // verifier. When that process is confirmed lost, forget the opaque routing
  // binding; never copy or persist the verifier to make the old code reusable.
  async unbindOAuthOwner(state: string, owner: string): Promise<boolean> {
    if (!safeId(state, 128) || !/^[a-f0-9]{64}$/.test(owner)) return false;
    return this.storage.transaction(async txn => {
      const now = this.now();
      const key = OAUTH_PREFIX + state;
      const current = await txn.get<unknown>(key);
      if (current === undefined) return true;
      if (typeof current !== "object" || current === null) throw new Error("Invalid persisted OAuth owner");
      const saved = current as Partial<SavedOAuthOwner>;
      if (typeof saved.expiresAt !== "number" || !Number.isSafeInteger(saved.expiresAt)) {
        throw new Error("Invalid persisted OAuth owner");
      }
      if (saved.expiresAt <= now) {
        await txn.delete(key);
        return true;
      }
      if (saved.owner !== owner) return false;
      await txn.delete(key);
      return true;
    });
  }

  async callbackOwner(state: string): Promise<string | undefined> {
    if (!safeId(state, 128)) return undefined;
    return this.storage.transaction(async txn => {
      const now = this.now();
      const key = OAUTH_PREFIX + state;
      const saved = await txn.get<unknown>(key);
      if (typeof saved !== "object" || saved === null) return undefined;
      const owner = saved as Partial<SavedOAuthOwner>;
      if (typeof owner.owner !== "string" || !/^[a-f0-9]{64}$/.test(owner.owner)
        || typeof owner.expiresAt !== "number" || !Number.isSafeInteger(owner.expiresAt)) throw new Error("Invalid persisted OAuth owner");
      if (owner.expiresAt <= now) {
        await txn.delete(key);
        return undefined;
      }
      return owner.owner;
    });
  }

  async writeShared<T>(lease: FencedLease, object: string, expectedVersion: number, value: T): Promise<{ok: true; version: number} | {ok: false; reason: "stale_owner" | "conflict"}> {
    this.validateLease(lease);
    if (!safeId(object, 256) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new RangeError("Invalid shared state write");
    return this.storage.transaction(async txn => {
      const now = this.now();
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

  private validateLeaseInput(resource: string, owner: string, leaseMs: number): void {
    if (!safeId(resource) || !safeId(owner)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > MAX_LEASE_MS) throw new RangeError("Invalid pool lease input");
  }

  private validateLease(lease: FencedLease): void {
    if (!safeId(lease.resource) || !safeId(lease.owner) || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
      || !Number.isSafeInteger(lease.expiresAt)) throw new RangeError("Invalid fenced lease");
  }

  private validateAffinityKey(key: string): void {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new RangeError("Invalid session affinity key");
  }

  private validateAffinityOwner(ownerId: string): void {
    if (!/^[a-f0-9]{64}$/.test(ownerId)) throw new RangeError("Invalid session affinity owner");
  }

  private validateAffinityWrite(expectedVersion: number, authId: string, ttlMs: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0
      || typeof authId !== "string" || authId.length < 1 || authId.length > 256
      || containsControlCharacter(authId)
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_AFFINITY_MS) {
      throw new RangeError("Invalid session affinity write");
    }
  }

  private validSessionAffinity(value: unknown): value is SavedSessionAffinity {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Partial<SavedSessionAffinity>;
    return typeof record.authId === "string" && record.authId.length <= 256
      && (record.authId === "" || !containsControlCharacter(record.authId))
      && typeof record.owner === "string" && /^[a-f0-9]{64}$/.test(record.owner)
      && typeof record.version === "number" && Number.isSafeInteger(record.version) && record.version >= 1
      && typeof record.expiresAt === "number" && Number.isSafeInteger(record.expiresAt) && record.expiresAt >= 0;
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid pool clock");
    return now;
  }

  private async serializeResource<T>(resource: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resourceTails.get(resource);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.resourceTails.set(resource, current);
    if (previous !== undefined) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.resourceTails.get(resource) === current) this.resourceTails.delete(resource);
    }
  }
}
