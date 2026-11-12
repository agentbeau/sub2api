import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PANEL_KEY, serveDashboard } from "../src/dashboard.ts";

const PANEL = "<!doctype html><html><head><title>Console</title></head><body>Native console</body></html>";
function store() {
  const body = new Response(PANEL).body!;
  const get = vi.fn(async () => ({ body, httpEtag: '\"tested-panel\"' } as R2ObjectBody));
  return { get, body };
}

describe("direct neutral console and custom hostname", () => {
  it.each(["/management.html", "/provider-panel.html"])("serves the checked native panel directly at %s", async (path) => {
    const state = store();
    const response = await serveDashboard(new Request(`https://api.agentbeau.dev${path}`), state);
    expect(response.status).toBe(200);
    expect(response.body).toBe(state.body);
    expect(await response.text()).toBe(PANEL);
    expect(state.get).toHaveBeenCalledExactlyOnceWith(PANEL_KEY);
    expect(response.headers.get("etag")).toBe('\"tested-panel\"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const source = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/<iframe|Start controls|setTimeout\(|setInterval\(|\/runtime\/start|controls_remaining_ms/);
  });

  it("answers HEAD without consuming or returning the HTML", async () => {
    const state = store();
    const response = await serveDashboard(new Request("https://api.agentbeau.dev/management.html", { method: "HEAD" }), state);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("etag")).toBe('\"tested-panel\"');
  });

  it("rejects writes and fails closed when the checked panel is missing", async () => {
    const get = vi.fn(async () => null);
    const write = await serveDashboard(new Request("https://api.agentbeau.dev/management.html", { method: "POST" }), { get });
    expect(write.status).toBe(405);
    expect(get).not.toHaveBeenCalled();
    expect((await serveDashboard(new Request("https://api.agentbeau.dev/management.html"), { get })).status).toBe(503);
  });

  it("keeps the native custom domain and existing state identities in the deployment configuration", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    expect(config.routes).toEqual([{ pattern: "api.agentbeau.dev", custom_domain: true }]);
    expect(config.name).toBe("sub2api");
    expect(config.durable_objects.bindings).toEqual([{ name: "CPA", class_name: "Cpa" }]);
    expect(config.r2_buckets).toEqual([{ binding: "STATE", bucket_name: "sub2api" }]);
    expect(config.vars.CONTAINER_IDLE_TIMEOUT_MS).toBe("1000");
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Cpa"] }]);
  });
});
