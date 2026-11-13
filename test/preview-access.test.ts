import { describe, expect, it } from "vitest";
import { previewAllowed } from "../src/preview-access.ts";
describe("preview owner identity", () => {
  const aud = "b".repeat(64);
  it("allows only a matching verified platform audience", () => {
    expect(previewAllowed(aud, { aud })).toBe(true);
    expect(previewAllowed(aud, { aud: "c".repeat(64) })).toBe(false);
  });
  it("fails closed without provisioning or platform identity", () => {
    for (const expected of [undefined, "", "REQUIRES_PREVIEW_OWNER_ACCESS_AUDIENCE", "invalid"]) {
      expect(previewAllowed(expected, { aud })).toBe(false);
    }
    expect(previewAllowed(aud, undefined)).toBe(false);
    expect(previewAllowed(aud, {})).toBe(false);
  });
});
