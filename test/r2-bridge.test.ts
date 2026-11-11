import { describe, expect, it } from "vitest";
import { handleR2Bridge } from "../src/r2-bridge.ts";
import { MemoryStore } from "./memory-store.ts";

describe("container R2 bridge", () => {
  it("stores CPA configuration only through its internal HTTP host", async () => {
    const store = new MemoryStore();
    const response = await handleR2Bridge(new Request("http://r2.internal/state/config/config.yaml", { method: "PUT", body: "access:\n  api-keys: [saved]" }), store);
    expect(response.status).toBe(200);
    expect(store.text("config/config.yaml")).toBe("access:\n  api-keys: [saved]");
  });

  it.each(["https://r2.internal", "http://other.internal", "http://r2.internal:8317", "http://r2.internal.evil.example"])("refuses %s without touching saved state", async (origin) => {
    const store = new MemoryStore();
    const response = await handleR2Bridge(new Request(`${origin}/state/config/config.yaml`, { method: "PUT", body: "replacement" }), store);
    expect(response.status).toBe(403);
    expect(store.entries.size).toBe(0);
  });

  it("refuses a contradictory Host header even if the URL is internal", async () => {
    const store = new MemoryStore();
    const response = await handleR2Bridge(new Request("http://r2.internal/state/config/config.yaml", {
      method: "PUT", headers: { host: "outside.example" }, body: "replacement",
    }), store);
    expect(response.status).toBe(403);
    expect(store.entries.size).toBe(0);
  });
});
