export const PANEL_KEY = "dashboard/management.html";

export function methodNotAllowed(allow: string): Response {
  return Response.json({ error: { message: "Method not allowed." } }, { status: 405, headers: { allow, "cache-control": "no-store" } });
}

// Called only after the existing session check. Serve the checked native console
// directly: no wrapper, iframe, start button, editing deadline or polling loop.
// Reading this static artifact does not contact the provider container.
export async function serveDashboard(request: Request, store: Pick<R2Bucket, "get">): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
    "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'; base-uri 'self'",
  });
  try {
    const object = await store.get(PANEL_KEY);
    if (object === null) throw new Error("Panel is not provisioned");
    headers.set("etag", object.httpEtag);
    if (request.method === "HEAD") {
      void object.body.cancel().catch(() => {});
      return new Response(null, { headers });
    }
    return new Response(object.body, { headers });
  } catch {
    return Response.json({ error: { message: "The dashboard bundle is unavailable. Check the deployment's dashboard artifact." } }, {
      status: 503, headers: { "cache-control": "no-store" },
    });
  }
}
