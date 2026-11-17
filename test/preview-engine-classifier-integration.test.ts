import { describe, it, expect, vi } from "vitest";
import { LeaseStorage } from "./lease-storage.ts";
vi.mock("cloudflare:workers", () => {
  class PlatformEntrypoint<E> { constructor(protected readonly ctx: DurableObjectState, protected readonly env: E) {} }
  return { DurableObject: PlatformEntrypoint, WorkerEntrypoint: PlatformEntrypoint };
});
import { Engine } from "../src/preview.ts";
import { Cpa } from "../src/cpa.ts";
const KEY = "synthetic-preview-integration-0123456789";
const configuration = `config-version: 8\naccess:\n  api-keys: [${KEY}]\n`;
const low = { answers: { effort: { choice: "low", probabilities: { low: 0.95 } } } };
function platform(decide: () => Promise<unknown>, withContainer = true, revision = "f".repeat(40), implementation: "preview" | "production" = "preview", enabled = true) {
  const events: string[] = [], forwarded: Request[] = [];
  const waitUntilTasks: Promise<unknown>[] = [];
  let running = false, initialization: Promise<unknown> = Promise.resolve();
  const store = new LeaseStorage();
  const storage = {
    get: <T>(key: string) => store.get<T>(key), put: (key: string, value: unknown) => store.put(key, value),
    delete: (key: string) => store.delete(key), deleteAlarm: async () => {},
    transaction: <T>(callback: (txn: LeaseStorage) => Promise<T>) => callback(store),
  };
  const context = {
    storage, exports: { R2Bridge: {} },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => { const result = callback(); initialization = result; return result; },
    waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); void task.catch(() => {}); },
    ...(withContainer ? { container: {
      get running() { return running; },
      start: () => { events.push("start"); running = true; },
      interceptOutboundHttp: async () => { events.push("attach"); },
      setInactivityTimeout: async () => {},
      getTcpPort: () => ({ fetch: async (input: Request) => {
        const path = new URL(input.url).pathname;
        if (path === "/healthz") return new Response("ok");
        if (path === "/__sub2api/lifecycle") return Response.json({ activity_protocol: 1, frontend_auth_protocol: 1, initialization_protocol: 1, initialization_ready: true });
        events.push("forward"); forwarded.push(input); return Response.json({ ok: true });
      } }),
    } } : {}),
  };
  const ai = vi.fn(async (_model: string, _input: unknown) => {
    events.push(_model === "@cf/cloudflare/clef-flash" ? "clef" : "unexpected-clef-model");
    if (typeof _input !== "object" || _input === null) events.push("invalid-clef-input");
    return decide();
  });
  const env = {
    CLEF_ENABLED: enabled ? "true" : "false", AI: { run: ai }, CONTAINER_IDLE_TIMEOUT_MS: "30000",
    DASHBOARD_AUTH: "cloudflare", ACCESS_AUD: "synthetic-preview-audience", PREVIEW_SOURCE_REVISION: revision,
    STATE: {
      get: async (key: string) => {
        if (key !== "config/config.yaml") return null;
        events.push("key-policy"); return { text: async () => configuration };
      },
      head: async () => null,
    },
    LOGIN_LIMIT: { limit: async () => ({ success: true }) },
  };
  const engine = implementation === "production"
    ? new Cpa(context as unknown as DurableObjectState, env as unknown as ConstructorParameters<typeof Cpa>[1])
    : new Engine(context as unknown as DurableObjectState, env as unknown as ConstructorParameters<typeof Engine>[1]);
  return { engine, ai, events, forwarded, waitUntilTasks, initialized: () => initialization };
}
function request(effort?: string, key = KEY, signal?: AbortSignal) {
  const body = { model: "gpt-6-luna", messages: [{ role: "system", content: "Keep this instruction" }, { role: "user", content: "PRIVATE_PRIOR_HISTORY" }, { role: "user", content: "Calculate 21 plus 22" }], tools: [{ type: "function", function: { name: "retain" } }], ...(effort === undefined ? {} : { reasoning_effort: effort }) };
  return new Request("https://preview.example/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
}
describe("real enhanced Engine/Cpa classifier integration", () => {
  it("reports the exact deployed source revision on private runtime status", async () => {
    const revision = "a".repeat(40);
    const p = platform(async () => low, true, revision); await p.initialized();
    const response = await p.engine.fetchWithAccess(new Request("https://preview.example/runtime/status"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-pmlabs-engine-revision")).toBe(revision);
  });

  it("verifies key, classifies, then attaches/starts/forwards the original payload plus effort", async () => {
    const p = platform(async () => low); await p.initialized(); const input = request(); const original = await input.clone().json();
    expect((await p.engine.fetch(input)).status).toBe(200);
    expect(p.events.indexOf("key-policy")).toBeLessThan(p.events.indexOf("clef"));
    expect(p.events.indexOf("clef")).toBeLessThan(p.events.indexOf("attach"));
    expect(p.events.indexOf("attach")).toBeLessThan(p.events.indexOf("start"));
    expect(p.events.indexOf("start")).toBeLessThan(p.events.indexOf("forward"));
    expect(p.ai).toHaveBeenCalledTimes(1); expect(p.forwarded).toHaveLength(1);
    expect(await p.forwarded[0]?.json()).toEqual({ ...original as object, reasoning_effort: "low" });
  });
  it("uses the same authenticated classifier from the production Cpa entrypoint", async () => {
    const p = platform(async () => low, true, "f".repeat(40), "production"); await p.initialized();
    const input = request(); const original = await input.clone().json();
    expect((await p.engine.fetch(input)).status).toBe(200);
    expect(p.events.indexOf("key-policy")).toBeLessThan(p.events.indexOf("clef"));
    expect(p.ai).toHaveBeenCalledWith("@cf/cloudflare/clef-flash", expect.objectContaining({ model: "clef-flash", state: "Calculate 21 plus 22" }));
    const classified = await p.forwarded[0]?.json() as Record<string, unknown>;
    expect(classified).toEqual({ ...original as object, reasoning_effort: "low" });
    expect(JSON.stringify(p.ai.mock.calls[0]?.[1])).not.toMatch(/Keep this instruction|PRIVATE_PRIOR_HISTORY|retain|authorization|synthetic-preview-integration/);
  });
  it("bypasses Clef for explicit effort through production Cpa", async () => {
    const p = platform(async () => low, true, "f".repeat(40), "production"); await p.initialized();
    const input = request("high"); const original = await input.clone().text();
    expect((await p.engine.fetch(input)).status).toBe(200);
    expect(p.ai).not.toHaveBeenCalled();
    expect(await p.forwarded[0]?.text()).toBe(original);
  });
  it.each(["throws", "low-confidence", "malformed"])("fails open for a production classifier result that %s", async mode => {
    const decide = mode === "throws" ? () => Promise.reject(new Error("synthetic AI outage"))
      : mode === "malformed" ? async () => ({ answers: { effort: { choice: "urgent", probabilities: { urgent: 1 } } } })
      : async () => ({ answers: { effort: { choice: "high", probabilities: { high: 0.4 } } } });
    const p = platform(decide, true, "f".repeat(40), "production"); await p.initialized();
    const input = request(); const original = await input.clone().text();
    expect((await p.engine.fetch(input)).status).toBe(200);
    expect(p.ai).toHaveBeenCalledTimes(1);
    expect(await p.forwarded[0]?.text()).toBe(original);
  });
  it("stops awaiting Clef on caller cancellation without starting CPA", async () => {
    let complete!: (result: unknown) => void;
    const pendingDecision = new Promise<unknown>(resolve => { complete = resolve; });
    const p = platform(() => pendingDecision, true, "f".repeat(40), "production"); await p.initialized();
    const controller = new AbortController(); const input = request(undefined, KEY, controller.signal);
    const responsePromise = p.engine.fetch(input);
    await vi.waitFor(() => expect(p.ai).toHaveBeenCalledTimes(1));
    expect(p.waitUntilTasks).toHaveLength(1);
    controller.abort(new Error("synthetic client disconnect"));
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(p.events).not.toContain("start");
    expect(p.events).not.toContain("forward");
    expect(p.forwarded).toHaveLength(0);
    const stats = (p.engine as unknown as { classifierStats: () => { inFlight: number } }).classifierStats();
    expect(stats.inFlight).toBe(1); // Workers AI has no documented AbortSignal input; this call may still incur usage.
    complete(low);
    await p.waitUntilTasks[0];
    expect((p.engine as unknown as { classifierStats: () => { inFlight: number } }).classifierStats().inFlight).toBe(0);
  });
  it("keeps production Clef disabled until the release flag is explicitly enabled", async () => {
    const p = platform(async () => low, true, "f".repeat(40), "production", false); await p.initialized();
    const input = request(); const original = await input.clone().text();
    expect((await p.engine.fetch(input)).status).toBe(200);
    expect(p.ai).not.toHaveBeenCalled();
    expect(await p.forwarded[0]?.text()).toBe(original);
  });
  it("rejects invalid key without AI or container startup", async () => {
    const p = platform(async () => low); await p.initialized();
    expect((await p.engine.fetch(request(undefined, "wrong"))).status).toBe(401);
    expect(p.ai).not.toHaveBeenCalled(); expect(p.events).not.toContain("start");
  });
  it("explicit effort bypasses AI and still starts and forwards", async () => {
    const p = platform(async () => low); await p.initialized(); const input = request("high"); const original = await input.clone().text();
    expect((await p.engine.fetch(input)).status).toBe(200); expect(p.ai).not.toHaveBeenCalled();
    expect(await p.forwarded[0]?.text()).toBe(original); expect(p.events).toContain("start");
  });
  it.each(["error", "timeout"])("AI %s preserves successful forwarding", async mode => {
    const p = platform(() => mode === "error" ? Promise.reject(new Error("synthetic AI outage")) : new Promise(() => {}));
    await p.initialized(); const input = request(); const original = await input.clone().text();
    expect((await p.engine.fetch(input)).status).toBe(200); expect(p.ai).toHaveBeenCalledTimes(1);
    expect(await p.forwarded[0]?.text()).toBe(original);
  });
  it("missing container linkage reproduces generic 503 even when explicit effort bypasses Clef", async () => {
    const p = platform(async () => low, false); await p.initialized();
    const response = await p.engine.fetch(request("low")); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { message: "The gateway is starting or unavailable. Try again shortly." } });
    expect(p.ai).not.toHaveBeenCalled(); expect(p.events).not.toContain("start");
  });
});
