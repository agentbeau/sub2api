import type { Env } from "./env.ts";
import { handle } from "./gateway.ts";
import { KeyGuard } from "./key-guard.ts";
import { classify } from "./routes.ts";

export { Cpa, R2Bridge } from "./cpa.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);
type EdgeEnv = Pick<Env, "DASHBOARD_PASSWORD" | "LOGIN_LIMIT"> & {
  readonly CPA: DurableObjectNamespace;
};

export default {
  fetch(request: Request, env: EdgeEnv) {
    const forward = (forwarded: Request) => env.CPA.getByName("cf-singleton-container").fetch(forwarded);
    switch (classify(new URL(request.url).pathname)) {
      case "health":
      case "home":
      case "login":
      case "logout":
      case "blocked":
        // These routes use no provider state. Avoid a DO round trip and do not refresh its
        // activity merely because a monitor checked liveness or a browser opened the sign-in.
        return handle(request, {
          dashboardPassword: env.DASHBOARD_PASSWORD ?? "",
          nowSeconds,
          keyGuard: new KeyGuard(nowSeconds),
          loginLimiter: env.LOGIN_LIMIT,
        }, forward);
      default:
        // API, dashboard, callback and readiness requests share the original singleton and
        // its KeyGuard. The gateway still decides whether each request needs CPA at all.
        return forward(request);
    }
  },
} satisfies ExportedHandler<Env>;
