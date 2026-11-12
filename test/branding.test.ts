import { describe, expect, it } from "vitest";
import { publicProviderResponse } from "../src/branding.ts";

describe("public provider response branding", () => {
  it("returns the original response when no engine header or exposure token needs changing", async () => {
    const response = new Response("CPA is provider payload, not a public label", { headers: {
      "content-type": "text/plain", "x-cpa": "not the engine prefix", "x-other-cpa-version": "keep",
      "x-provider-info": "CPA protocol metadata", "access-control-expose-headers": "Content-Type, X-Request-ID",
    } });
    expect(publicProviderResponse(response)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("CPA is provider payload, not a public label");
  });

  it("renames engine headers case-insensitively without changing their values or other metadata", async () => {
    const response = new Response('{"provider":"CPA","client_version":"cpa"}', {
      status: 429, statusText: "Provider busy", headers: {
        "X-CPA-VERSION": "v8.0.67", "x-cpa-Commit": "abc123", "X-cPa-BUILD-DATE": "2026-11-12T00:00:00Z",
        "x-cpa-support-plugin": "true", "X-CPA-HOME-VERSION": "home-4", "X-CPA-SAFE-MODE": "example-api-key",
        "retry-after": "8", "x-request-id": "request-123", "content-type": "application/json",
      },
    });
    const result = publicProviderResponse(response);
    expect(result.status).toBe(429);
    expect(result.statusText).toBe("Provider busy");
    expect(Object.fromEntries(result.headers)).toEqual({
      "x-sub2api-engine-version": "v8.0.67", "x-sub2api-engine-commit": "abc123",
      "x-sub2api-engine-build-date": "2026-11-12T00:00:00Z", "x-sub2api-engine-support-plugin": "true",
      "x-sub2api-engine-home-version": "home-4", "x-sub2api-engine-safe-mode": "example-api-key",
      "retry-after": "8", "x-request-id": "request-123", "content-type": "application/json",
    });
    expect(response.headers.get("x-cpa-version")).toBe("v8.0.67");
    expect(result.body).toBe(response.body);
    expect(response.bodyUsed).toBe(false);
    expect(await result.text()).toBe('{"provider":"CPA","client_version":"cpa"}');
  });

  it("updates exposed engine header names while keeping other CORS tokens", () => {
    const response = new Response(null, { headers: {
      "X-CPA-VERSION": "v8.0.67",
      "access-control-expose-headers": "Content-Type, X-CPA-VERSION,  x-cpa-Build-Date,\tX-CPA-SUPPORT-PLUGIN, X-Request-ID",
    } });
    const result = publicProviderResponse(response);
    expect(result.headers.get("access-control-expose-headers")?.split(",").map((token) => token.trim())).toEqual([
      "Content-Type", "x-sub2api-engine-version", "x-sub2api-engine-build-date", "x-sub2api-engine-support-plugin", "X-Request-ID",
    ]);
  });

  it("renames advertised engine headers even when that response does not carry their values", () => {
    const response = new Response(null, { headers: { "access-control-expose-headers": "X-CPA-VERSION, ETag" } });
    const result = publicProviderResponse(response);
    expect(result.headers.get("access-control-expose-headers")).toBe("x-sub2api-engine-version, ETag");
    expect(result.headers.has("x-sub2api-engine-version")).toBe(false);
  });

  it("preserves stream identity, backpressure and cancellation while changing headers", async () => {
    let pulls = 0;
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("data: CPA protocol content\n\n"));
      },
      cancel(reason) { cancelled = reason; },
    }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: { "x-cpa-version": "v8.0.67", "content-type": "text/event-stream" } });
    const result = publicProviderResponse(response);
    expect(result.headers.get("x-sub2api-engine-version")).toBe("v8.0.67");
    expect(result.body).toBe(stream);
    expect(pulls).toBe(0);
    expect(response.bodyUsed).toBe(false);
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: CPA protocol content\n\n");
    expect(pulls).toBe(1);
    await reader.cancel("client disconnected");
    expect(cancelled).toBe("client disconnected");
  });

  it("preserves a bodyless response when changing headers", () => {
    const response = new Response(null, { status: 204, headers: { "X-CPA-COMMIT": "abc123" } });
    const result = publicProviderResponse(response);
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
    expect(result.headers.get("x-sub2api-engine-commit")).toBe("abc123");
  });

  it("retains both values if the provider already sent the new header name", () => {
    const result = publicProviderResponse(new Response(null, { headers: {
      "x-sub2api-engine-version": "existing", "X-CPA-VERSION": "upstream",
    } }));
    expect(result.headers.get("x-sub2api-engine-version")).toBe("existing, upstream");
    expect(result.headers.has("x-cpa-version")).toBe(false);
  });
});
