import type { Cpa } from "./cpa.ts";

export interface Env {
  readonly CPA: DurableObjectNamespace<Cpa>;
  readonly STATE: R2Bucket;
  readonly LOGIN_LIMIT: RateLimit;
  readonly MANAGEMENT_KEY?: string;
  readonly DASHBOARD_PASSWORD?: string;
  readonly DASHBOARD_AUTH?: string;
  readonly ACCESS_AUD?: string;
  readonly CONTAINER_IDLE_TIMEOUT_MS?: string;
}
