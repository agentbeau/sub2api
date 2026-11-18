import { describe, expect, it } from "vitest";
import { PoolCoordinator, sessionShard, type PoolStorage, type PoolTransaction } from "../src/pool-coordination.ts";

class AtomicStorage implements PoolStorage {
  private readonly values = new Map<string, unknown>();
  private queue = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async transaction<T>(callback: (txn: PoolTransaction) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await callback(this); } finally { release(); }
  }
  async blockTransactions(): Promise<() => void> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
}

describe("pool coordination preparation primitives", () => {
  it("serializes concurrent OAuth refresh claims to one owner", async () => {
    const pool = new PoolCoordinator(new AtomicStorage(), () => 10_000);
    const claims = await Promise.all(Array.from({ length: 12 }, (_, index) => pool.claimRefresh("credential-7", `boot-${index}`, 5_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean);
    if (!winner) throw new Error("Expected one refresh owner");
    expect(await pool.claimRefresh("credential-7", winner.owner, 5_000)).toBeUndefined();
  });

  it("requires explicit lease renewal instead of a re-entrant same-owner claim", async () => {
    let now = 1_000;
    const pool = new PoolCoordinator(new AtomicStorage(), () => now);
    const lease = await pool.claimRefresh("credential-renew", "container-1-boot-7", 2_000);
    if (!lease) throw new Error("Expected refresh owner");
    expect(await pool.claimRefresh("credential-renew", lease.owner, 2_000)).toBeUndefined();
    now = 2_500;
    const renewed = await pool.renewRefresh(lease, 2_000);
    if (!renewed) throw new Error("Expected active lease renewal");
    expect(renewed).toMatchObject({ owner: lease.owner, epoch: lease.epoch, expiresAt: 4_500 });
    expect(await pool.claimRefresh("credential-renew", lease.owner, 2_000)).toBeUndefined();
    now = 4_500;
    expect(await pool.renewRefresh(renewed, 2_000)).toBeUndefined();
    expect((await pool.claimRefresh("credential-renew", lease.owner, 2_000))?.epoch).toBe(lease.epoch + 1);
  });

  it("fences a stale owner after lease takeover and rejects its writes", async () => {
    let now = 10_000;
    const pool = new PoolCoordinator(new AtomicStorage(), () => now);
    const old = await pool.claimRefresh("credential-7", "boot-old", 2_000);
    now = 12_001;
    const current = await pool.claimRefresh("credential-7", "boot-new", 2_000);
    if (!old || !current) throw new Error("Expected refresh owner claims");
    expect(current.epoch).toBe(2);
    expect(await pool.writeShared(old, "credential-file", 0, { tokenVersion: 1 })).toEqual({ ok: false, reason: "stale_owner" });
    expect(await pool.writeShared(current, "credential-file", 0, { tokenVersion: 2 })).toEqual({ ok: true, version: 1 });
    expect(await pool.readShared("credential-file")).toMatchObject({ fence: 2, value: { tokenVersion: 2 } });
  });

  it("keeps a session on the same shard across calls and validates pool size", async () => {
    const first = sessionShard("project-session-42", 3);
    const repeated = sessionShard("project-session-42", 3);
    expect(repeated).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0); expect(first).toBeLessThan(3);
    expect(() => sessionShard("", 3)).toThrow(RangeError);
  });

  it("routes an OAuth callback to the owner shard while its opaque state is live", async () => {
    let now = 20_000;
    const pool = new PoolCoordinator(new AtomicStorage(), () => now);
    expect(await pool.bindOAuthState("oauth-state-123", 2, 30_000)).toBe(true);
    now = 40_000;
    expect(await pool.callbackShard("oauth-state-123")).toBe(2);
    now = 50_000;
    expect(await pool.callbackShard("oauth-state-123")).toBeUndefined();
  });

  it("allows crash/restart takeover only after lease expiry and advances the epoch", async () => {
    const storage = new AtomicStorage();
    let now = 1_000;
    const firstRuntime = new PoolCoordinator(storage, () => now);
    const first = await firstRuntime.claimRefresh("credential-9", "container-1-boot-a", 3_000);
    const restartedRuntime = new PoolCoordinator(storage, () => now);
    now = 3_999;
    expect(await restartedRuntime.claimRefresh("credential-9", "container-2-boot-b", 3_000)).toBeUndefined();
    now = 4_001;
    const takeover = await restartedRuntime.claimRefresh("credential-9", "container-2-boot-b", 3_000);
    expect(takeover?.epoch).toBe((first?.epoch ?? 0) + 1);
  });

  it("rejects shared-state lost updates with a version compare-and-swap", async () => {
    const pool = new PoolCoordinator(new AtomicStorage(), () => 10_000);
    const lease = await pool.claimRefresh("account-3", "boot-1", 10_000);
    if (!lease) throw new Error("Expected refresh lease");
    const results = await Promise.all([
      pool.writeShared(lease, "account-config", 0, { model: "first" }),
      pool.writeShared(lease, "account-config", 0, { model: "second" }),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.reason === "conflict")).toHaveLength(1);
  });

  it("rejects a queued shared write when the lease expires before its transaction begins", async () => {
    const storage = new AtomicStorage();
    let now = 10_000;
    const pool = new PoolCoordinator(storage, () => now);
    const lease = await pool.claimRefresh("credential-queued", "boot-owner", 2_000);
    if (!lease) throw new Error("Expected refresh lease");
    const release = await storage.blockTransactions();
    const write = pool.writeShared(lease, "queued-token", 0, { tokenVersion: 2 });
    now = 12_000; // The caller queued this operation before expiry; admission must use transaction-time.
    release();
    expect(await write).toEqual({ ok: false, reason: "stale_owner" });
    expect(await pool.readShared("queued-token")).toBeUndefined();
  });

  it("serializes simultaneous OAuth callback binds to one owner shard", async () => {
    const pool = new PoolCoordinator(new AtomicStorage(), () => 30_000);
    const outcomes = await Promise.all([
      pool.bindOAuthState("one-time-state", 1, 30_000),
      pool.bindOAuthState("one-time-state", 2, 30_000),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const owner = await pool.callbackShard("one-time-state");
    expect([1, 2]).toContain(owner);
  });

  it("allows a different boot incarnation to take over only after the current lease expires", async () => {
    const storage = new AtomicStorage();
    let now = 50_000;
    const oldProcess = new PoolCoordinator(storage, () => now);
    const current = await oldProcess.claimRefresh("provider-account", "container-a-boot-17", 1_000);
    if (!current) throw new Error("Expected initial refresh owner");
    const restartedProcess = new PoolCoordinator(storage, () => now);
    expect(await restartedProcess.claimRefresh("provider-account", "container-a-boot-18", 1_000)).toBeUndefined();
    now = 51_001;
    const takeover = await restartedProcess.claimRefresh("provider-account", "container-a-boot-18", 1_000);
    expect(takeover?.epoch).toBe(current.epoch + 1);
    expect(await oldProcess.writeShared(current, "provider-token", 0, { tokenVersion: 1 })).toEqual({ ok: false, reason: "stale_owner" });
  });

  it("validates a fence at write time and rejects an expired lease during an in-flight refresh", async () => {
    let now = 70_000;
    const storage = new AtomicStorage();
    const coordinator = new PoolCoordinator(storage, () => now);
    const old = await coordinator.claimRefresh("refresh-credential", "a".repeat(64) + ":" + "b".repeat(32), 1_000);
    if (!old) throw new Error("Expected initial refresh lease");
    expect(await coordinator.currentLease(old.resource, old.owner, old.epoch)).toBe(true);
    now += 1_001;
    const replacement = await coordinator.claimRefresh("refresh-credential", "c".repeat(64) + ":" + "d".repeat(32), 1_000);
    if (!replacement) throw new Error("Expected lease takeover");
    expect(await coordinator.currentLease(old.resource, old.owner, old.epoch)).toBe(false);
    expect(await coordinator.currentLease(replacement.resource, replacement.owner, replacement.epoch)).toBe(true);
  });

  it("holds the ownership queue through the persistence commit before allowing takeover", async () => {
    let now = 90_000;
    const coordinator = new PoolCoordinator(new AtomicStorage(), () => now);
    const old = await coordinator.claimRefresh("shared-config", "a".repeat(64) + ":" + "b".repeat(32), 1_000);
    if (old === undefined) throw new Error("Expected initial lease");
    let entered!: () => void;
    let finish!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const commit = coordinator.withCurrentLease(old.resource, old.owner, old.epoch, async () => {
      entered();
      await blocked;
      return "committed";
    });
    await inside;
    now += 1_001;
    const takeover = coordinator.claimRefresh(old.resource, "c".repeat(64) + ":" + "d".repeat(32), 1_000);
    await expect(Promise.race([takeover.then(() => "takeover"), Promise.resolve("queued")])).resolves.toBe("queued");
    finish();
    await expect(commit).resolves.toEqual({ ok: true, value: "committed" });
    const replacement = await takeover;
    expect(replacement?.epoch).toBe(old.epoch + 1);
    await expect(coordinator.withCurrentLease(old.resource, old.owner, old.epoch, async () => "stale"))
      .resolves.toEqual({ ok: false, reason: "stale_owner" });
  });

  it("durably routes an OAuth callback to its initiating container and refuses rebinding", async () => {
    let now = 80_000;
    const coordinator = new PoolCoordinator(new AtomicStorage(), () => now);
    const owner = "1".repeat(64);
    expect(await coordinator.bindOAuthOwner("state-from-cpa", owner, 30_000)).toBe(true);
    expect(await coordinator.callbackOwner("state-from-cpa")).toBe(owner);
    expect(await coordinator.bindOAuthOwner("state-from-cpa", "2".repeat(64), 30_000)).toBe(false);
    now += 30_001;
    expect(await coordinator.callbackOwner("state-from-cpa")).toBeUndefined();
  });

  it("invalidates only the old OAuth owner after process loss and preserves a newer binding", async () => {
    let now = 90_000;
    const coordinator = new PoolCoordinator(new AtomicStorage(), () => now);
    const oldOwner = "a".repeat(64);
    const newOwner = "b".repeat(64);
    expect(await coordinator.bindOAuthOwner("restart-state", oldOwner, 30_000)).toBe(true);
    expect(await coordinator.unbindOAuthOwner("restart-state", newOwner)).toBe(false);
    expect(await coordinator.callbackOwner("restart-state")).toBe(oldOwner);
    expect(await coordinator.unbindOAuthOwner("restart-state", oldOwner)).toBe(true);
    expect(await coordinator.callbackOwner("restart-state")).toBeUndefined();
    expect(await coordinator.bindOAuthOwner("restart-state", newOwner, 30_000)).toBe(true);
    expect(await coordinator.unbindOAuthOwner("restart-state", oldOwner)).toBe(false);
    expect(await coordinator.callbackOwner("restart-state")).toBe(newOwner);
    now += 30_001;
    expect(await coordinator.unbindOAuthOwner("restart-state", newOwner)).toBe(true);
    expect(await coordinator.callbackOwner("restart-state")).toBeUndefined();
  });
});
