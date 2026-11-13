import { describe, expect, it, vi } from "vitest";

// Capture the environment delivered to both inherited runtime entrypoints,
// without loading the Cloudflare runtime or generated gateway Wasm.
vi.mock("../src/cpa.ts", () => {
  class Entry {
    env: Record<string, unknown>;
    constructor(_ctx: unknown, env: Record<string, unknown>) { this.env = env; }
  }
  return { Cpa: Entry, R2Bridge: Entry };
});
vi.mock("../src/index.ts", () => ({ default: { fetch: vi.fn(() => new Response("ok")) } }));
import gateway from "../src/index.ts";
import preview, { Engine, R2Bridge } from "../src/preview.ts";
import type { Env } from "../src/env.ts";

describe("isolated preview entrypoint bindings", () => {
  const engine = { getByName: vi.fn() };
  const state = {};
  const aud = "a".repeat(64);
  const env = { ENGINE: engine, STATE: state, PREVIEW_ACCESS_AUD: aud } as unknown as Omit<Env, "CPA"> & { ENGINE: Env["CPA"]; PREVIEW_ACCESS_AUD: string };
  it("maps ENGINE for the Durable Object and R2 activity bridge without replacing STATE", () => {
    for (const entry of [
      new Engine({} as DurableObjectState, env),
      new R2Bridge({} as ExecutionContext, env),
    ]) {
      const captured = (entry as unknown as { env: Env }).env;
      expect(captured.CPA).toBe(engine);
      expect(captured.STATE).toBe(state);
    }
    expect(env).not.toHaveProperty("CPA");
  });
  it("maps the public dispatch only after verified owner access", async () => {
    vi.mocked(gateway.fetch).mockClear();
    const request = new Request("https://preview.invalid/");
    const denied = await preview.fetch(request, env, {} as ExecutionContext);
    expect(denied.status).toBe(403);
    expect(gateway.fetch).not.toHaveBeenCalled();
    await preview.fetch(request, env, { access: { aud } } as ExecutionContext & { access: { aud: string } });
    expect(vi.mocked(gateway.fetch).mock.calls[0]?.[1].CPA).toBe(engine);
    expect(vi.mocked(gateway.fetch).mock.calls[0]?.[1].STATE).toBe(state);
  });
});
