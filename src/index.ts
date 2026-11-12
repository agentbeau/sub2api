import type { Env } from "./env.ts";
import { handle } from "./gateway.ts";
import { serveDashboard } from "./dashboard.ts";
import { classify } from "./routes.ts";

export { Cpa, R2Bridge } from "./cpa.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);
type EdgeEnv = Pick<Env, "DASHBOARD_PASSWORD" | "LOGIN_LIMIT" | "STATE"> & {
  readonly CPA: DurableObjectNamespace;
};

export default {
  fetch(request: Request, env: EdgeEnv) {
    const forward = (forwarded: Request) => env.CPA.getByName("cf-singleton-container").fetch(forwarded);
    const path = new URL(request.url).pathname;
    const config = {
      dashboardPassword: env.DASHBOARD_PASSWORD ?? "", nowSeconds,
      apiAccess: { authorize: async () => "unavailable" as const, invalidate() {} },
      loginLimiter: env.LOGIN_LIMIT,
    };
    if (path === "/management.html" || path === "/provider-panel.html") {
      return handle(request, config, (authenticated) => serveDashboard(authenticated, env.STATE));
    }
    switch (classify(path)) {
      case "health":
      case "home":
      case "login":
      case "logout":
      case "blocked":
        // These routes use no provider state. Avoid a DO round trip and do not refresh its
        // activity merely because a monitor checked liveness or a browser opened the sign-in.
        return handle(request, config, forward);
      default:
        // API, management, control, callback and explicit readiness requests retain the
        // original singleton. Its admission and lifecycle decide whether CPA may start.
        return forward(request);
    }
  },
} satisfies ExportedHandler<Env>;
