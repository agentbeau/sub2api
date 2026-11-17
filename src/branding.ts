function publicHeaderName(name: string): string {
  const prefix = name.match(/^x-(?:cpa|sub2api-engine)-/i);
  return prefix ? `x-engine-${name.slice(prefix[0].length).toLowerCase()}` : name;
}

// Change only public engine metadata. Provider bodies, protocol values and the
// original Response remain untouched unless a header actually needs changing.
// Public model APIs omit private engine metadata; the console keeps neutral
// names for its version/capability readers. Never rewrite provider payloads.
export function publicProviderResponse(response: Response, publicApi = false): Response {
  let headers: Headers | undefined;
  for (const [name, value] of response.headers) {
    const renamed = publicHeaderName(name);
    if (renamed === name && !(publicApi && /^x-engine-/i.test(name))) continue;
    headers ??= new Headers(response.headers);
    headers.delete(name);
    if (!publicApi) headers.append(renamed, value);
  }

  const exposed = response.headers.get("access-control-expose-headers");
  if (exposed !== null) {
    const renamed = exposed.split(",").map((token) => {
      const name = token.trim();
      const renamed = publicHeaderName(name);
      return publicApi && (renamed !== name || /^x-engine-/i.test(name)) ? "" : token.replace(name, renamed);
    }).filter(token => token.trim().length > 0).join(",");
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
