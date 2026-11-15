import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scheduler lab isolation", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.scheduler.jsonc", import.meta.url), "utf8"));
  it("has no public deployment or shared state", () => {
    expect(config.name).toBe("gateway-scheduler-lab");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.r2_buckets).toEqual([{ binding: "STATE", bucket_name: "gateway-scheduler-lab-state" }]);
    expect(config.vars.PREVIEW_ACCESS_AUD).toBe("REQUIRES_SEPARATE_SCHEDULER_ACCESS");
  });
  it("uses a replacement namespace, named image and no unsupported legacy sizing", () => {
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["ScheduledEngine"] }]);
    expect(config.durable_objects.bindings).toEqual([{ name: "ENGINE", class_name: "ScheduledEngine" }]);
    expect(config.containers).toHaveLength(1);
    const container = config.containers[0];
    expect(container.scheduling_policy).toBe("durable_object");
    expect(container.name).toBe("gateway-scheduler-lab-engine");
    expect(container.images.engine.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    for (const unsupported of ["max_instances", "instance_type", "image", "image_build_context"]) {
      expect(container).not.toHaveProperty(unsupported);
    }
  });
});
