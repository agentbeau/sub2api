import { describe, expect, it } from "vitest";
import { schedulerOptions } from "../src/scheduler-options.ts";

const image = `registry.cloudflare.com/${"a".repeat(32)}/gateway-engine@sha256:${"b".repeat(64)}`;
describe("durable scheduler lab startup", () => {
  it("uses the version-pinned image and bounded lab size", () => {
    expect(schedulerOptions(true, { engine: image })).toEqual({ image, instance: "lite" });
  });
  it("rejects any alternate DO name", () => {
    expect(() => schedulerOptions(false, { engine: image })).toThrow(/singleton/);
  });
  it("fails closed without a pinned named image", () => {
    for (const value of [undefined, "", "cloudflare/debian-trixie", "docker.io/engine:latest", image.replace(/@sha256:.*/, ":latest")]) {
      expect(() => schedulerOptions(true, value === undefined ? {} : { engine: value })).toThrow(/digest-pinned/);
    }
  });
});
