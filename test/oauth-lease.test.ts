import { describe, expect, it } from "vitest";
import { OAuthLease, type OAuthLeaseStorage } from "../src/oauth-lease.ts";

class MemoryStorage implements OAuthLeaseStorage {
  readonly records = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.records.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.records.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

function at(path: string, method = "GET", authenticated = true): Request {
  return new Request(`https://gateway.example${path}`, {
    method,
    headers: authenticated ? { authorization: "Bearer management-key" } : {},
  });
}

function start(state: string, more: Record<string, unknown> = {}): Response {
  return Response.json({ status: "ok", state, url: "https://provider.example/authorize", ...more });
}

function fixture() {
  let now = 1_800_000_000_000;
  const storage = new MemoryStorage();
  const lease = new OAuthLease(storage, () => now);
  return { storage, lease, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("OAuth inactivity leases", () => {
  it("keeps callback sign-in alive across the dashboard's three-second polling gap", async () => {
    const state = fixture();
    const response = start("callback-one");
    expect(await state.lease.observe(at("/v0/management/codex-auth-url"), response)).toBe(true);
    state.advance(3000);
    expect(state.lease.remainingMs()).toBe(357_000);
    expect(response.bodyUsed).toBe(false);
    expect((await response.json() as { state: string }).state).toBe("callback-one");
  });

  it.each([
    ["/v0/management/anthropic-auth-url", "GET"],
    ["/v0/management/codex-auth-url", "GET"],
    ["/v0/management/antigravity-auth-url", "GET"],
    ["/v0/management/kimi-auth-url", "GET"],
    ["/v0/management/kimi-ai-auth-url", "GET"],
    ["/v0/management/xai-auth-url", "GET"],
    ["/v0/management/devin-auth-url", "GET"],
    ["/v0/management/meta-auth-url", "GET"],
    ["/v8/management/oauth/auth-url?provider=codex", "GET"],
    ["/v8/management/oauth/auth-url", "POST"],
    ["/v8/management/oauth/siwc/bind", "POST"],
  ])("recognizes successful %s %s starts", async (path, method) => {
    const { lease } = fixture();
    await lease.observe(at(path, method), start("state-one", { expires_in: 300 }));
    expect(lease.remainingMs()).toBe(360_000);
  });

  it.each([
    [{ expires_in: 120 }, 180_000],
    [{ expires_in: 9_999_999 }, 1_860_000],
    [{ flow: "device" }, 1_860_000],
    [{ flow: "siwc_bind" }, 360_000],
    [{ expires_in: -1 }, 360_000],
  ])("bounds absolute expiry from %j", async (metadata, remaining) => {
    const { lease } = fixture();
    await lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("state-one", metadata));
    expect(lease.remainingMs()).toBe(remaining);
  });

  it("never slides a pending expiry when the dashboard polls or repeats a start response", async () => {
    const state = fixture();
    await state.lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("state-one", { expires_in: 120 }));
    state.advance(10_000);
    expect(await state.lease.observe(at("/v8/management/oauth/status?state=state-one"), Response.json({ status: "wait", expires_in: 999_999 }))).toBe(false);
    await state.lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("state-one", { expires_in: 999_999 }));
    expect(state.lease.remainingMs()).toBe(170_000);
    state.advance(170_000);
    expect(state.lease.remainingMs()).toBe(0);
    await state.lease.observe(at("/v8/management/oauth/status?state=state-one"), Response.json({ status: "wait" }));
    expect(state.lease.remainingMs()).toBe(0);
  });

  it.each([
    ["/v8/management/oauth/auth-url?provider=custom-plugin", "GET"],
    ["/v8/management/oauth/auth-url", "POST"],
  ])("preserves the full CPA session window for metadata-free or unknown flows at %s", async (path, method) => {
    const { lease } = fixture();
    await lease.observe(at(path, method), start("plugin-state"));
    expect(lease.remainingMs()).toBe(1_860_000);
  });

  it("tracks concurrent states independently and releases the last one after persistence grace", async () => {
    const state = fixture();
    await Promise.all([
      state.lease.observe(at("/v0/management/codex-auth-url"), start("callback-one")),
      state.lease.observe(at("/v0/management/xai-auth-url"), start("device-two", { flow: "device" })),
    ]);
    await state.lease.observe(at("/v0/management/get-auth-status?state=callback-one"), Response.json({ status: "ok" }));
    expect(state.lease.remainingMs()).toBe(1_860_000);
    await state.lease.observe(at("/v8/management/oauth/session?state=device-two", "DELETE"), Response.json({ status: "ok", cancelled: false }));
    expect(state.lease.remainingMs()).toBe(1_860_000);
    await state.lease.observe(at("/v8/management/oauth/session?state=device-two", "DELETE"), Response.json({ status: "ok", cancelled: true }));
    expect(state.lease.remainingMs()).toBe(35_000);
    state.advance(35_000);
    expect(state.lease.remainingMs()).toBe(0);
  });

  it("restores absolute flow and mutation deadlines after a Durable Object restart", async () => {
    const state = fixture();
    await state.lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("state-one", { expires_in: 300 }));
    state.advance(10_000);
    const restored = new OAuthLease(state.storage, state.now);
    await restored.restore();
    expect(restored.remainingMs()).toBe(350_000);
    await restored.observe(at("/v8/management/oauth/status?state=state-one"), Response.json({ status: "error" }));
    state.advance(5000);
    const completed = new OAuthLease(state.storage, state.now);
    await completed.restore();
    expect(completed.remainingMs()).toBe(30_000);
    state.advance(30_000);
    const expired = new OAuthLease(state.storage, state.now);
    await expired.restore();
    expect(expired.remainingMs()).toBe(0);
  });

  it("retains the in-memory hold and retries durability after a storage write fails", async () => {
    class FailingOnceStorage extends MemoryStorage {
      private failed = false;
      override async put(key: string, value: unknown): Promise<void> {
        if (!this.failed) { this.failed = true; throw new Error("storage temporarily unavailable"); }
        await super.put(key, value);
      }
    }
    const storage = new FailingOnceStorage();
    const now = () => 1_800_000_000_000;
    const lease = new OAuthLease(storage, now);
    await expect(lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("state-one"))).rejects.toThrow("storage temporarily unavailable");
    expect(lease.remainingMs()).toBe(360_000);
    await lease.observe(at("/v8/management/oauth/status?state=state-one"), Response.json({ status: "wait" }));
    const restored = new OAuthLease(storage, now);
    await restored.restore();
    expect(restored.remainingMs()).toBe(360_000);
  });

  it("does not slide completion grace on repeated terminal status polls", async () => {
    const state = fixture();
    await state.lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("state-one"));
    await state.lease.observe(at("/v8/management/oauth/status?state=state-one"), Response.json({ status: "ok" }));
    state.advance(10_000);
    expect(await state.lease.observe(at("/v8/management/oauth/status?state=state-one"), Response.json({ status: "ok" }))).toBe(false);
    expect(state.lease.remainingMs()).toBe(25_000);
  });

  it("clears only temporary holds after the provider process is confirmed stopped", async () => {
    const state = fixture();
    await state.storage.put("unrelated-state", { preserve: true });
    await state.lease.observe(at("/v0/management/codex-auth-url"), start("lost-process-state"));
    await state.lease.observe(at("/v8/management/config", "PUT"), Response.json({ status: "ok" }));
    await state.lease.clear();
    expect(state.lease.remainingMs()).toBe(0);
    expect(await state.storage.get("unrelated-state")).toEqual({ preserve: true });
    const restored = new OAuthLease(state.storage, state.now);
    await restored.restore();
    expect(restored.remainingMs()).toBe(0);
  });

  it("keeps a pending lease after callback acceptance while token exchange continues", async () => {
    const state = fixture();
    await state.lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("state-one"));
    state.advance(10_000);
    await state.lease.observe(at("/v8/management/oauth/callback", "POST"), Response.json({ status: "ok" }));
    expect(state.lease.remainingMs()).toBe(350_000);
  });

  it("reserves a bounded persistence grace for successful management writes", async () => {
    const state = fixture();
    const response = new Response("saved");
    await state.lease.observe(at("/v8/management/config/access/api-keys", "PUT"), response);
    expect(state.lease.remainingMs()).toBe(35_000);
    state.advance(10_000);
    await state.lease.observe(at("/v8/management/config/access/api-keys"), Response.json({ keys: [] }));
    expect(state.lease.remainingMs()).toBe(25_000);
    expect(response.bodyUsed).toBe(false);
    state.advance(25_000);
    expect(state.lease.remainingMs()).toBe(0);
  });

  it("does not reserve persistence time for a management preflight", async () => {
    const { lease } = fixture();
    expect(await lease.observe(at("/v8/management/config", "OPTIONS"), new Response(null, { status: 204 }))).toBe(false);
    expect(lease.remainingMs()).toBe(0);
  });

  it("ignores failed, anonymous, non-OAuth reads and unrelated provider responses", async () => {
    const { lease } = fixture();
    for (const [request, response] of [
      [at("/v8/management/oauth/auth-url", "GET", false), start("anonymous")],
      [at("/v8/management/oauth/auth-url?provider=codex"), Response.json({ status: "ok", state: "unauthorized" }, { status: 401 })],
      [at("/v8/management/config", "PUT"), new Response("failed", { status: 500 })],
      [at("/v8/management/config"), start("not-a-start")],
      [at("/v8/management/oauth/auth-url/extra"), start("not-an-exact-route")],
      [at("/v1/messages", "POST"), start("model-output")],
    ] as const) {
      expect(await lease.observe(request, response)).toBe(false);
      expect(response.bodyUsed).toBe(false);
    }
    expect(lease.remainingMs()).toBe(0);
  });

  it("leaves inference streams untouched and only persists state IDs and deadlines", async () => {
    const { lease, storage } = fixture();
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode("data: model token\n\n"));
      controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    expect(await lease.observe(at("/v1/messages", "POST"), response)).toBe(false);
    expect(pulls).toBe(0);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("data: model token\n\n");
    await lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), start("safe-state", {
      url: "https://provider.example/authorize?code=private-code", access_token: "private-token", refresh_token: "private-refresh",
    }));
    const saved = JSON.stringify(Array.from(storage.records.values()));
    expect(saved).toContain("safe-state");
    expect(saved).not.toContain("private-");
    expect(saved).not.toContain("provider.example");
  });

  it("rejects oversized or malformed OAuth JSON without consuming the original response", async () => {
    const { lease } = fixture();
    for (const text of ["{broken", JSON.stringify({ status: "ok", state: "oversized", padding: "x".repeat(32_768) })]) {
      const response = new Response(text, { headers: { "content-type": "application/json" } });
      expect(await lease.observe(at("/v8/management/oauth/auth-url?provider=codex"), response)).toBe(false);
      expect(response.bodyUsed).toBe(false);
      expect(await response.text()).toBe(text);
    }
    expect(lease.remainingMs()).toBe(0);
  });
});
