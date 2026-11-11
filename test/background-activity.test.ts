import { describe, expect, it } from "vitest";
import { BackgroundActivity, handleBackgroundActivity, type ActivityStorage, type BackgroundAction } from "../src/background-activity.ts";

const first = "a".repeat(32);
const second = "b".repeat(32);

function fixture() {
  let now = 1_800_000_000_000;
  const data = new Map<string, unknown>();
  let failWrites = false;
  const storage: ActivityStorage = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put<T>(key: string, value: T) {
      if (failWrites) throw new Error("storage unavailable");
      data.set(key, structuredClone(value));
    },
    async delete(key: string) { return data.delete(key); },
  };
  return {
    activity: new BackgroundActivity(storage, () => now), storage, data,
    advance: (ms: number) => { now += ms; }, clock: () => now,
    failWrites: () => { failWrites = true; },
  };
}

describe("actual background work leases", () => {
  it("adds no idle hold before work and grants a persisted 90-second window before work starts", async () => {
    const f = fixture();
    await f.activity.restore();
    expect(f.activity.remainingMs()).toBe(0);
    expect(await f.activity.update("begin", first)).toBe(true);
    expect(f.activity.remainingMs()).toBe(90_000);
    expect(f.data.size).toBe(1);
    const next = new BackgroundActivity(f.storage, f.clock);
    await next.restore();
    expect(next.remainingMs()).toBe(90_000);
  });

  it("retains running work across a DO restart without extending its deadline", async () => {
    const f = fixture();
    await f.activity.update("begin", first);
    f.advance(40_000);
    const next = new BackgroundActivity(f.storage, f.clock);
    await next.restore();
    expect(next.remainingMs()).toBe(50_000);
    f.advance(50_000);
    expect(next.remainingMs()).toBe(0);
    expect(await next.update("renew", first)).toBe(false);
  });

  it("renews only an existing unexpired job and releases after its work finishes", async () => {
    const f = fixture();
    expect(await f.activity.update("renew", first)).toBe(false);
    await f.activity.update("begin", first);
    f.advance(30_000);
    expect(await f.activity.update("renew", first)).toBe(true);
    expect(f.activity.remainingMs()).toBe(90_000);
    expect(await f.activity.update("end", first)).toBe(true);
    expect(f.activity.remainingMs()).toBe(0);
    expect(f.data.size).toBe(0);
  });

  it("does not allow a duplicate begin or repeated renewals to extend the 15-minute absolute ceiling", async () => {
    const f = fixture();
    await f.activity.update("begin", first);
    f.advance(30_000);
    expect(await f.activity.update("begin", first)).toBe(false);
    for (let i = 1; i <= 29; i++) {
      if (i > 1) f.advance(30_000);
      expect(await f.activity.update("renew", first)).toBe(true);
    }
    expect(f.activity.remainingMs()).toBe(30_000);
    f.advance(30_000);
    expect(await f.activity.update("renew", first)).toBe(false);
    expect(f.activity.remainingMs()).toBe(0);
  });

  it("keeps independent concurrent operations until each finishes", async () => {
    const f = fixture();
    expect(await Promise.all([f.activity.update("begin", first), f.activity.update("begin", second)])).toEqual([true, true]);
    await f.activity.update("end", first);
    expect(f.activity.remainingMs()).toBe(90_000);
    const next = new BackgroundActivity(f.storage, f.clock);
    await next.restore();
    expect(await next.update("end", second)).toBe(true);
    expect(next.remainingMs()).toBe(0);
  });

  it("clears jobs from a stopped process before a cold start", async () => {
    const f = fixture();
    await f.activity.update("begin", first);
    await f.activity.clear();
    expect(f.activity.remainingMs()).toBe(0);
    expect(f.data.size).toBe(0);
    expect(await f.activity.update("renew", first)).toBe(false);
  });

  it("does not acknowledge activity whose durable grant failed", async () => {
    const f = fixture();
    f.failWrites();
    await expect(f.activity.update("begin", first)).rejects.toThrow("storage unavailable");
  });

  it.each(["", "a".repeat(31), "A".repeat(32), "../" + "a".repeat(29)])("rejects malformed work identity %s", async (id) => {
    const f = fixture();
    expect(await f.activity.update("begin", id)).toBe(false);
    expect(f.activity.remainingMs()).toBe(0);
    expect(f.data.size).toBe(0);
  });
});

function request(body: unknown, url = "http://r2.internal/__sub2api/activity") {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("internal activity HTTP boundary", () => {
  it.each(["begin", "renew", "end"] as const)("accepts a valid %s operation without returning stored data", async (action) => {
    const calls: Array<[BackgroundAction, string]> = [];
    const result = await handleBackgroundActivity(request({ action, id: first }), async (a, id) => { calls.push([a, id]); return true; });
    expect(result.status).toBe(204);
    expect(await result.text()).toBe("");
    expect(calls).toEqual([[action, first]]);
  });

  it.each([
    "https://r2.internal/__sub2api/activity", "http://public.example/__sub2api/activity",
    "http://r2.internal:8080/__sub2api/activity", "http://r2.internal/__sub2api/activity/",
    "http://r2.internal/__sub2api/activity?override=1",
  ])("refuses activity outside the exact internal address: %s", async (url) => {
    let called = false;
    const result = await handleBackgroundActivity(request({ action: "begin", id: first }, url), async () => { called = true; return true; });
    expect(result.status).toBe(404);
    expect(called).toBe(false);
  });

  it.each([{ action: "destroy", id: first }, { action: "begin", id: "bad" }, [], null, { action: "begin" }])("rejects invalid protocol data", async (body) => {
    let called = false;
    const result = await handleBackgroundActivity(request(body), async () => { called = true; return true; });
    expect(result.status).toBe(400);
    expect(called).toBe(false);
  });

  it("limits the body before dispatch, regardless of a missing content length", async () => {
    let called = false;
    const result = await handleBackgroundActivity(request({ action: "begin", id: first, padding: "x".repeat(2048) }), async () => { called = true; return true; });
    expect(result.status).toBe(413);
    expect(called).toBe(false);
  });

  it("reports refused grants and storage failures without leaking exception data", async () => {
    const rejected = await handleBackgroundActivity(request({ action: "renew", id: first }), async () => false);
    expect(rejected.status).toBe(409);
    const failed = await handleBackgroundActivity(request({ action: "begin", id: first }), async () => { throw new Error("private-provider-credential"); });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private-provider-credential");
  });

  it("requires POST and JSON", async () => {
    const get = await handleBackgroundActivity(new Request("http://r2.internal/__sub2api/activity"), async () => true);
    expect(get.status).toBe(405);
    const wrongType = await handleBackgroundActivity(new Request("http://r2.internal/__sub2api/activity", { method: "POST", body: "{}" }), async () => true);
    expect(wrongType.status).toBe(415);
  });

  it("rejects a conflicting Host header before dispatch", async () => {
    const input = request({ action: "begin", id: first });
    input.headers.set("host", "public.example");
    let called = false;
    const result = await handleBackgroundActivity(input, async () => { called = true; return true; });
    expect(result.status).toBe(404);
    expect(called).toBe(false);
  });
});
