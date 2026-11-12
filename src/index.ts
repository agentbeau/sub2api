import type { Env } from "./env.ts";
import { handle } from "./gateway.ts";
import { serveDashboard } from "./dashboard.ts";
import { classify } from "./routes.ts";
import { accessRequired, crossOriginWrite, dashboardAccess, isBrowserRoute, withoutAccessCredentials, type NativeAccessContext } from "./access.ts";

export { Cpa, R2Bridge } from "./cpa.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);
type EdgeEnv = Pick<Env, "DASHBOARD_PASSWORD" | "DASHBOARD_AUTH" | "ACCESS_AUD" | "LOGIN_LIMIT" | "STATE"> & {
  readonly CPA: DurableObjectNamespace;
};

export default {
  fetch(request: Request, env: EdgeEnv, ctx?: ExecutionContext): Response | Promise<Response> {
    const forward = (forwarded: Request) => env.CPA.getByName("cf-singleton-container").fetch(forwarded);
    const path = new URL(request.url).pathname;
    const route = classify(path);
    const authenticated = dashboardAccess(env, ctx as (ExecutionContext & NativeAccessContext) | undefined);
    if (authenticated !== undefined && isBrowserRoute(route)) {
      if (!authenticated) return accessRequired();
      if (crossOriginWrite(request)) {
        return Response.json({ error: "Use a same-origin authenticated request." }, {
          status: 403, headers: { "cache-control": "no-store" },
        });
      }
    }
    const config = {
      dashboardPassword: env.DASHBOARD_PASSWORD ?? "", nowSeconds,
      dashboardAccess: authenticated,
      apiAccess: { authorize: async () => "unavailable" as const, invalidate() {} },
      loginLimiter: env.LOGIN_LIMIT,
    };
    if (path === "/management.html" || path === "/provider-panel.html") {
      return handle(request, config, (authorized) => serveDashboard(authorized, env.STATE));
    }
    switch (route) {
      case "health":
      case "home":
      case "login":
      case "logout":
      case "blocked":
        return handle(request, config, forward);
      default:
        // Access context does not propagate through a Durable Object fetch.
        // Carry the verified decision over a private, typed RPC, not a header.
        // Public API requests always retain their independent client-key checks.
        if (authenticated === true && isBrowserRoute(route)) {
          return (env.CPA as Env["CPA"]).getByName("cf-singleton-container").fetchWithAccess(withoutAccessCredentials(request));
        }
        return forward(request);
    }
  },
} satisfies ExportedHandler<Env>;
