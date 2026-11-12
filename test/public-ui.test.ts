import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { serveDashboard } from "../src/dashboard.ts";

describe("neutral console and custom hostname", () => {
  it("serves an unbranded controls shell without reading the provider panel or starting anything", async () => {
    const get = vi.fn();
    const response = await serveDashboard(new Request("https://api.agentbeau.dev/management.html"), { get });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<title>Provider controls</title>");
    expect(html).toContain("<h1>Provider controls</h1>");
    expect(html).not.toMatch(/sub2api|CLIProxyAPI|CLI Proxy API|CPAMC|\bCPA\b|github\.com/);
    expect(html).toContain("Start controls");
    expect(html).toContain("panel.src='/provider-panel.html'");
    expect(get).not.toHaveBeenCalled();
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
