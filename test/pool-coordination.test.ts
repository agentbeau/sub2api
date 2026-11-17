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
}

describe("pool coordination preparation primitives", () => {
  it("serializes concurrent OAuth refresh claims to one owner", async () => {
    const pool = new PoolCoordinator(new AtomicStorage());
    const claims = await Promise.all(Array.from({ length: 12 }, (_, index) => pool.claimRefresh("credential-7", `boot-${index}`, 10_000, 5_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("fences a stale owner after lease takeover and rejects its writes", async () => {
    const pool = new PoolCoordinator(new AtomicStorage());
    const old = await pool.claimRefresh("credential-7", "boot-old", 10_000, 2_000);
    const current = await pool.claimRefresh("credential-7", "boot-new", 12_001, 2_000);
    if (!old || !current) throw new Error("Expected refresh owner claims");
    expect(current.epoch).toBe(2);
    expect(await pool.writeShared(old, "credential-file", 0, { tokenVersion: 1 }, 12_001)).toEqual({ ok: false, reason: "stale_owner" });
    expect(await pool.writeShared(current, "credential-file", 0, { tokenVersion: 2 }, 12_001)).toEqual({ ok: true, version: 1 });
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
    const pool = new PoolCoordinator(new AtomicStorage());
    expect(await pool.bindOAuthState("oauth-state-123", 2, 20_000, 30_000)).toBe(true);
    expect(await pool.callbackShard("oauth-state-123", 40_000)).toBe(2);
    expect(await pool.callbackShard("oauth-state-123", 50_000)).toBeUndefined();
  });

  it("allows crash/restart takeover only after lease expiry and advances the epoch", async () => {
    const storage = new AtomicStorage();
    const firstRuntime = new PoolCoordinator(storage);
    const restartedRuntime = new PoolCoordinator(storage);
    const first = await firstRuntime.claimRefresh("credential-9", "container-1-boot-a", 1_000, 3_000);
    expect(await restartedRuntime.claimRefresh("credential-9", "container-2-boot-b", 3_999, 3_000)).toBeUndefined();
    const takeover = await restartedRuntime.claimRefresh("credential-9", "container-2-boot-b", 4_001, 3_000);
    expect(takeover?.epoch).toBe((first?.epoch ?? 0) + 1);
  });

  it("rejects shared-state lost updates with a version compare-and-swap", async () => {
    const pool = new PoolCoordinator(new AtomicStorage());
    const lease = await pool.claimRefresh("account-3", "boot-1", 10_000, 10_000);
    if (!lease) throw new Error("Expected refresh lease");
    const results = await Promise.all([
      pool.writeShared(lease, "account-config", 0, { model: "first" }, 10_001),
      pool.writeShared(lease, "account-config", 0, { model: "second" }, 10_001),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.reason === "conflict")).toHaveLength(1);
  });
});
