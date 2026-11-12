import { handleGateway, minPasswordLength } from "./wasm.ts";
import { withoutAccessCredentials } from "./access.ts";

export type Forward = (request: Request) => Promise<Response>;

export type ApiAccessDecision = "allowed" | "denied" | "unconfigured" | "unavailable" | "not-found";

export interface ApiAccess {
  // Inspect saved configuration and request metadata without reading the body
  // or contacting the provider container. Only an explicit allowance forwards.
  authorize(request: Request): Promise<ApiAccessDecision>;
  invalidate(): void;
}

export interface LoginLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GatewayConfig {
  readonly dashboardPassword: string;
  // Supplied only from verified platform Access context or the private RPC.
  // false rejects legacy cookies/passwords; undefined retains legacy installs.
  readonly dashboardAccess?: boolean | undefined;
  readonly nowSeconds: () => number;
  readonly apiAccess: ApiAccess;
  readonly loginLimiter: LoginLimiter;
}

export const MIN_PASSWORD_LENGTH = minPasswordLength();

// Rust owns public request policy. Admission reads the authoritative saved
// configuration; it has no forwarding callback and cannot fall back to a probe.
export function handle(request: Request, config: GatewayConfig, forward: Forward): Promise<Response> {
  return handleGateway(
    request,
    config.dashboardPassword,
    config.nowSeconds,
    (forwarded: Request) => forward(withoutAccessCredentials(forwarded)),
    (candidate: Request) => config.apiAccess.authorize(candidate),
    () => { config.apiAccess.invalidate(); },
    async (client: string) => (await config.loginLimiter.limit({ key: client })).success,
    config.dashboardAccess,
  );
}
