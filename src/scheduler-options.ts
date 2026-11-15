import type { ContainerImageOptions } from "./container-lifecycle.ts";

export const SCHEDULER_SINGLETON = "cf-singleton-container";

// Never accept an image, size or instance ID from a request. Wrangler pins the
// named image to this Worker version; the lab starts only its one named DO.
export function schedulerOptions(isSingleton: boolean, images: Record<string, string>): ContainerImageOptions {
  if (!isSingleton) throw new Error("Only the scheduler lab singleton may start");
  const image = images.engine;
  if (image === undefined || !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error("A digest-pinned managed-registry engine image is required");
  }
  // basic is unavailable under durable_object. lite is deliberately a lab
  // candidate, not an untested claim of production memory equivalence.
  return { image, instance: "lite" };
}
