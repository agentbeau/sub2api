import { describe, expect, it } from "vitest";
import { ManagementWindow } from "../src/management-window.ts";
import { LeaseStorage } from "./lease-storage.ts";

describe("explicit management activity", () => {
  it("starts empty and grants only a bounded, non-sliding two-minute window", async () => {
    let now = 1000;
    const window = new ManagementWindow(new LeaseStorage(), () => now);
    expect(window.remainingMs()).toBe(0);
    await window.open();
    expect(window.remainingMs()).toBe(120_000);
    now += 50_000;
    expect(window.remainingMs()).toBe(70_000);
    expect(window.remainingMs()).toBe(70_000);
    now += 80_000;
    expect(window.remainingMs()).toBe(0);
  });

  it("restores the original deadline after object eviction without renewing it", async () => {
    const storage = new LeaseStorage();
    await new ManagementWindow(storage, () => 1000).open();
    const restored = new ManagementWindow(storage, () => 31_000);
    await restored.restore();
    expect(restored.remainingMs()).toBe(90_000);
    const expired = new ManagementWindow(storage, () => 121_001);
    await expired.restore();
    expect(expired.remainingMs()).toBe(0);
  });

  it("closing controls clears only its own hold", async () => {
    const storage = new LeaseStorage();
    await storage.put("unrelated-provider-state", "preserve");
    const window = new ManagementWindow(storage, () => 1000);
    await window.open();
    await window.clear();
    expect(window.remainingMs()).toBe(0);
    const restored = new ManagementWindow(storage, () => 1000);
    await restored.restore();
    expect(restored.remainingMs()).toBe(0);
    expect(await storage.get("unrelated-provider-state")).toBe("preserve");
  });
});
