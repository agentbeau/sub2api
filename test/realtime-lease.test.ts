import { describe, expect, it, vi } from "vitest";
import { RealtimeLease } from "../src/realtime-lease.ts";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
}

function fixture(storage = new MemoryStorage()) {
  let now = 1_800_000_000_250;
  const clock = () => now;
  return { storage, lease: new RealtimeLease(storage, clock), now: clock, advance: (ms: number) => { now += ms; } };
}

function request(path = "/v1/realtime/client_secrets", method = "POST") {
  return new Request(`https://gateway.example${path}`, { method, headers: { authorization: "Bearer admitted-client-key" } });
}

function issued(expiresAt: number, value = "ek_provider-generated-secret") {
  return Response.json({ value, expires_at: expiresAt, session: { type: "realtime", model: "gpt-realtime" } });
}

describe("temporary realtime credential inactivity", () => {
  it("keeps a minted credential alive until its absolute expiry plus fractional-second margin", async () => {
    const state = fixture();
    const expiry = Math.floor(state.now() / 1000) + 600;
    const response = issued(expiry);
    expect(await state.lease.observe(request(), response)).toBe(true);
    expect(state.lease.remainingMs()).toBe(600_750);
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toMatchObject({ value: "ek_provider-generated-secret", expires_at: expiry });
    state.advance(3000);
    expect(state.lease.remainingMs()).toBe(597_750);
    expect([...state.storage.values.values()]).toEqual([expiry * 1000 + 1000]);
  });

  it("uses the nested legacy credential expiry instead of unrelated session expiry", async () => {
    const state = fixture();
    await state.lease.observe(request("/v1/realtime/sessions"), Response.json({
      expires_at: Math.floor(state.now() / 1000) + 7200,
      client_secret: { value: "ek_legacy-secret", expires_at: Math.floor(state.now() / 1000) + 600 },
    }));
    expect(state.lease.remainingMs()).toBe(600_750);
  });

  it("bounds the hold by the provider's two-hour maximum plus rounding margin", async () => {
    const state = fixture();
    await state.lease.observe(request(), issued(Math.floor(state.now() / 1000) + 86_400));
    expect(state.lease.remainingMs()).toBe(7_201_000);
  });

  it("retains the longest concurrently issued credential without saving token values", async () => {
    const state = fixture();
    const seconds = Math.floor(state.now() / 1000);
    await Promise.all([
      state.lease.observe(request(), issued(seconds + 600, "ek_long-secret")),
      state.lease.observe(request(), issued(seconds + 60, "ek_short-secret")),
    ]);
    expect(state.lease.remainingMs()).toBe(600_750);
    expect([...state.storage.values.values()]).toEqual([(seconds + 600) * 1000 + 1000]);
  });

  it("does not renew or release reusable credentials on use, disconnect or repeated mint responses", async () => {
    const state = fixture();
    const expiry = Math.floor(state.now() / 1000) + 10;
    await state.lease.observe(request(), issued(expiry));
    state.advance(3000);
    expect(await state.lease.observe(request(), issued(expiry))).toBe(false);
    await state.lease.observe(request("/v1/realtime", "GET"), new Response("connected"));
    await state.lease.observe(request("/v1/realtime/calls/call-one/hangup"), new Response(null, { status: 204 }));
    expect(state.lease.remainingMs()).toBe(7750);
    state.advance(7750);
    expect(state.lease.remainingMs()).toBe(0);
    expect(await state.lease.observe(request(), issued(expiry))).toBe(false);
    expect(state.lease.remainingMs()).toBe(0);
  });

  it("restores the same absolute deadline after object eviction and discards it after expiry", async () => {
    const state = fixture();
    await state.lease.observe(request(), issued(Math.floor(state.now() / 1000) + 600));
    state.advance(20_000);
    const restored = new RealtimeLease(state.storage, state.now);
    await restored.restore();
    expect(restored.remainingMs()).toBe(580_750);
    state.advance(580_750);
    const expired = new RealtimeLease(state.storage, state.now);
    await expired.restore();
    expect(expired.remainingMs()).toBe(0);
    expect(state.storage.values.size).toBe(0);
  });

  it("clears only its own deadline when a cold start confirms the issuing process is gone", async () => {
    const state = fixture();
    await state.storage.put("unrelated-state", { preserve: true });
    await state.lease.observe(request(), issued(Math.floor(state.now() / 1000) + 600));
    await state.lease.clear();
    expect(state.lease.remainingMs()).toBe(0);
    expect([...state.storage.values]).toEqual([["unrelated-state", { preserve: true }]]);
    const restored = new RealtimeLease(state.storage, state.now);
    await restored.restore();
    expect(restored.remainingMs()).toBe(0);
  });

  it("cannot restore an old process's hold from a response still being read during cold start", async () => {
    const state = fixture();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), {
      headers: { "content-type": "application/json" },
    });
    const pending = state.lease.observe(request(), response);
    await state.lease.clear();
    stream?.enqueue(new TextEncoder().encode(JSON.stringify({ value: "ek_old-process", expires_at: Math.floor(state.now() / 1000) + 600 })));
    stream?.close();
    expect(await pending).toBe(false);
    expect(state.lease.remainingMs()).toBe(0);
    expect(state.storage.values.size).toBe(0);
  });

  it.each([undefined, null, "1800000600", -1, 1.5, 1_799_999_999, Number.MAX_SAFE_INTEGER])("ignores malformed or expired expiry %j", async (expiresAt) => {
    const state = fixture();
    expect(await state.lease.observe(request(), Response.json({ value: "ek_bad-expiry", expires_at: expiresAt }))).toBe(false);
    expect(state.lease.remainingMs()).toBe(0);
  });

  it.each([undefined, null, "", "ek_", "unrelated-value"])("requires an actual minted credential value (%j)", async (value) => {
    const state = fixture();
    expect(await state.lease.observe(request(), Response.json({ value, expires_at: Math.floor(state.now() / 1000) + 600 }))).toBe(false);
    expect(state.lease.remainingMs()).toBe(0);
  });

  it.each([
    ["/v1/realtime/client_secrets", "GET", 200],
    ["/v1/realtime/sessions", "GET", 200],
    ["/v1/realtime/transcription_sessions", "POST", 200],
    ["/v1/realtime/translations/client_secrets", "POST", 200],
    ["/v1/realtime/client_secrets/extra", "POST", 200],
    ["/v1/realtime/client_secrets", "POST", 401],
    ["/v1/realtime/client_secrets", "POST", 403],
    ["/v1/realtime/client_secrets", "POST", 500],
  ])("never clones an unrelated or unsuccessful %s %s response (%i)", async (path, method, status) => {
    const state = fixture();
    const response = Response.json({ value: "ek_not-issued", expires_at: Math.floor(state.now() / 1000) + 600 }, { status });
    const clone = vi.spyOn(response, "clone");
    expect(await state.lease.observe(request(path, method), response)).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(state.lease.remainingMs()).toBe(0);
  });

  it("leaves normal inference request bodies and response streams unread and uncloned", async () => {
    const state = fixture();
    let responsePulls = 0;
    let requestPulls = 0;
    const input = new Request("https://gateway.example/v1/responses", {
      method: "POST", body: new ReadableStream({ pull() { requestPulls += 1; } }, { highWaterMark: 0 }),
      duplex: "half",
    } as RequestInit);
    const response = new Response(new ReadableStream({ pull() { responsePulls += 1; } }, { highWaterMark: 0 }), {
      headers: { "content-type": "text/event-stream" },
    });
    const clone = vi.spyOn(response, "clone");
    expect(await state.lease.observe(input, response)).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(responsePulls).toBe(0);
    expect(requestPulls).toBe(0);
    expect(input.bodyUsed).toBe(false);
    expect(response.bodyUsed).toBe(false);
    await input.body?.cancel();
    await response.body?.cancel();
  });

  it("accepts a valid session whose JSON escaping expands the 64KiB input beyond 128KiB", async () => {
    const state = fixture();
    const text = `{"value":"ek_large-session","expires_at":${Math.floor(state.now() / 1000) + 600},"session":{"instructions":"${"\\u003c".repeat(60 * 1024)}"}}`;
    expect(text.length).toBeGreaterThan(128 * 1024);
    expect(text.length).toBeLessThan(512 * 1024);
    const response = new Response(text, { headers: { "content-type": "application/json; charset=utf-8" } });
    expect(await state.lease.observe(request(), response)).toBe(true);
    expect(state.lease.remainingMs()).toBe(600_750);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe(text);
  });

  it("bounds chunked creation responses without a Content-Length and preserves the original", async () => {
    const state = fixture();
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(16 * 1024));
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    expect(await state.lease.observe(request(), response)).toBe(false);
    expect(pulls).toBeGreaterThan(32);
    expect(pulls).toBeLessThan(40);
    expect(response.bodyUsed).toBe(false);
    expect(state.lease.remainingMs()).toBe(0);
    await response.body?.cancel();
  });

  it("skips oversized declared bodies and non-JSON responses before cloning", async () => {
    const state = fixture();
    for (const headers of [{ "content-type": "application/json", "content-length": "524289" }, { "content-type": "text/event-stream" }]) {
      const response = new Response("not JSON", { headers });
      const clone = vi.spyOn(response, "clone");
      expect(await state.lease.observe(request(), response)).toBe(false);
      expect(clone).not.toHaveBeenCalled();
    }
  });

  it("retains the in-memory deadline and retries persistence after a failed storage write", async () => {
    class FailingStorage extends MemoryStorage {
      private failed = false;
      override async put(key: string, value: unknown): Promise<void> {
        if (!this.failed) { this.failed = true; throw new Error("storage temporarily unavailable"); }
        await super.put(key, value);
      }
    }
    const state = fixture(new FailingStorage());
    const expiry = Math.floor(state.now() / 1000) + 600;
    await expect(state.lease.observe(request(), issued(expiry))).rejects.toThrow("storage temporarily unavailable");
    expect(state.lease.remainingMs()).toBe(600_750);
    expect(await state.lease.observe(request(), issued(expiry))).toBe(false);
    const restored = new RealtimeLease(state.storage, state.now);
    await restored.restore();
    expect(restored.remainingMs()).toBe(600_750);
  });
});
