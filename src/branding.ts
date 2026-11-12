function publicHeaderName(name: string): string {
  const prefix = name.match(/^x-(?:cpa|sub2api-engine)-/i);
  return prefix ? `x-engine-${name.slice(prefix[0].length).toLowerCase()}` : name;
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
  // Preserve workerd's native upgrade handle, streaming and backpressure.
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers, cf: response.cf, webSocket: response.webSocket,
  });
}
