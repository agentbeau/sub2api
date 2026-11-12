export interface DashboardAccessEnv {
  readonly DASHBOARD_AUTH?: string;
  readonly ACCESS_AUD?: string;
}

export interface NativeAccessContext {
  readonly access?: { readonly aud: string };
}

// Only the platform context is trusted, never headers, cookies or a request body.
// Undefined retains password authentication for other installations; configured
// but invalid modes fail closed rather than silently falling back to a password.
export function dashboardAccess(env: DashboardAccessEnv, ctx?: Partial<ExecutionContext> & NativeAccessContext): boolean | undefined {
  if (env.DASHBOARD_AUTH === undefined) return undefined;
  return env.DASHBOARD_AUTH === "cloudflare" && typeof env.ACCESS_AUD === "string"
    && env.ACCESS_AUD.length > 0 && ctx?.access?.aud === env.ACCESS_AUD;
}

export function isBrowserRoute(route: string): boolean {
  return ["home", "login", "logout", "dashboard", "oauth-callback"].includes(route);
}

export function accessRequired(): Response {
  return Response.json({ error: "Cloudflare login required." }, {
    status: 401, headers: { "cache-control": "no-store" },
  });
}

// Access credentials belong to the dashboard, never to a model provider.
// Do not read or buffer the body, or alter the provider's Authorization header.
export function withoutAccessCredentials(request: Request): Request {
  const names = [...request.headers.keys()].filter(name => name === "cookie" || name.startsWith("cf-access-"));
  if (names.length === 0) return request;
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

export function crossOriginWrite(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  const origin = request.headers.get("origin");
  return (origin !== null && origin !== new URL(request.url).origin)
    || request.headers.get("sec-fetch-site") === "cross-site";
}
