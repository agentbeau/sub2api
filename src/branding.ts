function publicHeaderName(name: string): string {
  return /^x-cpa-/i.test(name) ? `x-sub2api-engine-${name.slice(6).toLowerCase()}` : name;
}

// Change only public engine metadata. Provider bodies, protocol values and the
// original Response remain untouched unless a header actually needs renaming.
export function publicProviderResponse(response: Response): Response {
  let headers: Headers | undefined;
  for (const [name, value] of response.headers) {
    const renamed = publicHeaderName(name);
    if (renamed === name) continue;
    headers ??= new Headers(response.headers);
    headers.delete(name);
    headers.append(renamed, value);
  }

  const exposed = response.headers.get("access-control-expose-headers");
  if (exposed !== null) {
    const renamed = exposed.split(",").map((token) => {
      const name = token.trim();
      return token.replace(name, publicHeaderName(name));
    }).join(",");
    if (renamed !== exposed) {
      headers ??= new Headers(response.headers);
      headers.set("access-control-expose-headers", renamed);
    }
  }
  if (headers === undefined) return response;
  // workerd carries an upgrade on ResponseInit, outside the body stream. Keep
  // that native handle when a 101 response needs different public headers.
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers, cf: response.cf, webSocket: response.webSocket,
  });
}
