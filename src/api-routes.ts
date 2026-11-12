export type ApiRoute = "standard" | "realtime" | "relay";

// CPA v8.0.67 internal/api/server_routes.go. Keep the public namespaces owned by
// the Rust gateway; the upstream /openai and /backend-api aliases stay private.
// container/patch-cpa checks this route surface and Gemini actions before building
// a newer CPA image; review both catalogs together when that compatibility gate fails.
const POST_ROUTES = new Set([
  "/v1/chat/completions", "/v1/completions", "/v1/images/generations", "/v1/images/edits",
  "/v1/videos", "/v1/videos/generations", "/v1/videos/edits", "/v1/videos/extensions",
  "/v1/audio/speech", "/v1/tts", "/v1/messages", "/v1/messages/count_tokens",
  "/v1/responses", "/v1/responses/compact", "/v1/alpha/search", "/v1/live",
  "/v1/realtime/client_secrets", "/v1/realtime/sessions", "/v1/realtime/transcription_sessions",
  "/v1/realtime/translations/client_secrets", "/v1beta/interactions",
]);

export function apiRoute(method: string, pathname: string): ApiRoute | null {
  if (pathname.includes("\\") || pathname.includes("//") || /%(?:2f|2e|5c)/i.test(pathname)) return null;
  let path: string;
  try {
    // Go's URL.Path is decoded, while the Workers URL exposes encoded pathnames.
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (path.startsWith("/v1beta/models/")) {
    if (method === "GET") return "standard";
    // The catch-all POST handler only implements these three Gemini actions.
    // It consumes its entire suffix, so a final slash is not a redirect here.
    return method === "POST" && /^\/v1beta\/models\/[^:]+:(generateContent|streamGenerateContent|countTokens)$/.test(path)
      ? "standard" : null;
  }
  if (method === "GET" && path.startsWith("/v1/models/")) return "standard";

  // Gin redirects a single trailing slash for its concrete/parameter routes.
  if (path.endsWith("/")) path = path.slice(0, -1);
  // Attached separately by sdk/cliproxy/service_lifecycle.go; CPA owns ws-auth.
  if (method === "GET" && path === "/v1/ws") return "relay";
  if ((method === "GET" || method === "POST") && (path === "/v1/realtime" || path === "/v1/realtime/translations")) return "realtime";
  if (method === "POST" && path === "/v1/realtime/calls") return "realtime";
  if (method === "GET" && /^\/v1\/realtime\/calls\/[^/]+$/.test(path)) return "realtime";

  if (method === "GET") {
    return path === "/v1/models" || path === "/v1/responses" || path === "/v1beta/models"
      || /^\/v1\/(videos|live)\/[^/]+$/.test(path) ? "standard" : null;
  }
  if (method === "POST") {
    return POST_ROUTES.has(path) || /^\/v1\/realtime\/calls\/[^/]+\/(hangup|accept|reject|refer)$/.test(path)
      ? "standard" : null;
  }
  return null;
}
