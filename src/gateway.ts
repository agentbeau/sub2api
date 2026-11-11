import type { KeyGuard } from "./key-guard.ts";
import { handleGateway, minPasswordLength } from "./wasm.ts";

export type Forward = (request: Request) => Promise<Response>;

export interface LoginLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GatewayConfig {
  readonly dashboardPassword: string;
  readonly nowSeconds: () => number;
  readonly keyGuard: KeyGuard;
  readonly loginLimiter: LoginLimiter;
}

export const MIN_PASSWORD_LENGTH = minPasswordLength();

// Rust owns public request policy. These callbacks expose the platform's shared
// key guard and rate limiter without introducing a second credential store.
export function handle(request: Request, config: GatewayConfig, forward: Forward): Promise<Response> {
  return handleGateway(
    request,
    config.dashboardPassword,
    config.nowSeconds,
    forward,
    (origin: string) => config.keyGuard.state(origin, forward),
    () => { config.keyGuard.forget(); },
    async (client: string) => (await config.loginLimiter.limit({ key: client })).success,
  );
}
