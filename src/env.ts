import type { Cpa } from "./cpa.ts";

export interface Env {
  readonly CPA: DurableObjectNamespace<Cpa>;
  readonly POOL_FENCING_ENABLED?: string;
  readonly POOL_SESSION_ROUTING_ENABLED?: string;
  readonly POOL_SESSION_AFFINITY_ENABLED?: string;
  readonly STATE: R2Bucket;
  readonly LOGIN_LIMIT: RateLimit;
  readonly MANAGEMENT_KEY?: string;
  readonly DASHBOARD_PASSWORD?: string;
  readonly DASHBOARD_AUTH?: string;
  readonly ACCESS_AUD?: string;
  readonly CONTAINER_IDLE_TIMEOUT_MS?: string;
  readonly CLEF_ENABLED?: string;
  readonly AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}
