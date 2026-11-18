# Gateway framework and itty ecosystem review

## Scope and result

Hono and itty-router are inbound JavaScript routing libraries. They do not replace this gateway's Rust/Wasm path policy, session and API-key decisions, Cloudflare Access enforcement, native response forwarding, or CPA container. Comparing either router directly with the complete gateway would not be feature-equivalent. This repository therefore measures route dispatch separately and keeps the existing full Rust-versus-TypeScript results in [performance.md](performance.md).

The existing end-to-end contract continues to run in `npm run test:runtime`: the actual Rust/Wasm Worker bundle is exercised in workerd with mocked provider responses, including authentication, a 2 MiB upload, streamed SSE, cancellation, readiness and WebSocket upgrade. That is compatibility evidence for the current gateway; the framework benchmark does not substitute for it and does not measure real provider inference.

## Router benchmark

Run `npm run benchmark:frameworks` with the pinned dev dependencies. It uses Hono 4.13.19, itty-router 5.0.24 and itty-fetcher 1.0.10. The exact Rust/Wasm classifier is imported from the current build. Hono and itty-router receive the same explicit route table and strict raw-path guard. All three return the same short response for a 27-path corpus containing the supported public routes, misses, prefix lookalikes, duplicate separators, backslashes and encoded separators.

The Node/V8 run reuses a prepared `Request`, constructs and reads the same response, alternates implementation order, and records five rounds of 3,000 operations after 300 warm-ups. On 2026-11-17 (Node 24.22.1, AMD EPYC 9V74), warm medians ranged from 4.86–5.72 µs for Rust/Wasm, 4.92–6.33 µs for Hono and 6.19–8.59 µs for itty-router across four representative paths. These are route-only local numbers; the small spread is not a production latency result.

The workerd run bundles each router into a fresh local Miniflare Worker. Three fresh-instance first-fetch samples had medians of 139 ms for Rust/Wasm, 114 ms for Hono and 95 ms for itty-router. Warm route medians were 0.90–1.01 ms, 0.85–0.96 ms and 0.78–0.89 ms respectively. These figures include Miniflare dispatch/startup overhead; they are not Cloudflare edge cold starts, container startup, billed CPU or end-to-end requests. The router-only fixture returns route labels and intentionally excludes gateway authentication and provider calls. It shows no basis for a 100× claim.

The separate full-gateway benchmark already recorded Rust/Wasm at 10.65× faster for authenticated dashboard checks and 5.22× faster for successful login versus the original TypeScript gateway, while the warm API forwarding path added about 20% local overhead. It excludes provider/network time; Hono and itty-router have not been ported to the complete policy implementation, so those ratios do not extend to them.

## Compatibility checks

In the same pinned-package run, both router adapters returned the original native SSE `Response`, preserved provider headers and the request's headers/body, propagated request abort, and kept response stream cancellation connected. These checks show that either can route to a handler that returns the native provider response; they do not cover Cloudflare WebSocket 101 behavior.

itty-fetcher was tested separately with a synthetic 502 SSE response and `parse: false`. The helper threw for the non-2xx status but preserved the original unread `Response`, headers, request signal and cancellation. Its default automatic JSON parsing/error behavior adds another condition to every provider response; its own docs list streams among cases to consider alternatives for. The gateway currently uses native Fetch and forwards provider responses without parsing them, so there is no demonstrated benefit to adopting the wrapper.

The current Hono WebSocket helper is an endpoint upgrade helper that gives the application WebSocket event handlers. The gateway's upstream path needs to pass through Cloudflare's native upgrade response and socket object. A raw pass-through may be possible in a Hono handler, but the helper is not a transparent provider WebSocket proxy; the existing tested Rust/Wasm path should remain until a real workerd 101 equivalence test exists.

## Other itty.dev projects

| Component | Fit for this gateway | Decision |
|---|---|---|
| [itty-router](https://itty.dev/itty-router/) | Small Worker-native router with fixed, parameter and wildcard patterns. It can express these routes, but would duplicate the Rust path policy and needs the same security, auth and streaming parity. The route microbenchmark did not show an advantage over the current Wasm classifier. | Keep as benchmark-only dev dependency. |
| [itty-fetcher](https://itty.dev/itty-fetcher/) | Outbound Fetch convenience wrapper. Raw mode passed the synthetic streaming test, but non-2xx responses throw and require special forwarding logic. It does not replace the gateway's existing request/response policy. | Do not use on provider forwarding. |
| [itty-sockets](https://ittysockets.com/) | Hosted channel/pub-sub client. It is not a reverse proxy for provider WebSocket sessions or a replacement for the current Cloudflare Durable Object/container ownership. Introducing it would send channel messages to a third-party service. | Not suitable; no provider data was sent to it. |
| [itty-packager](https://itty.dev/itty-packager/) | TypeScript library build and release CLI. This repository also builds Rust/Wasm, a separate CPA container image and a pinned dashboard artifact, with source-to-image provenance checks. | No verified benefit for the existing build pipeline. |
| [itty-time](https://itty.dev/itty-time/) | Helpers for converting and adding durations. Current lease and TTL logic uses a few integer timestamps and explicit limits. | Too small a problem to justify a dependency. |
| [itty-chroma](https://itty.dev/itty-chroma/) | Browser-console text styling. The product UI is HTML/CSS; runtime logs are not a user-facing terminal. | Not relevant. |
| [itty-durable](https://itty.dev/itty-durable/) | Its own catalog marks it deprecated. The gateway relies on native Cloudflare Durable Object and Container identity, alarms, RPC and storage semantics. | Do not adopt. |

## References

- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Hono routing strategies](https://hono.dev/docs/concepts/routers)
- [Hono streaming helper](https://hono.dev/docs/helpers/streaming)
- [Hono WebSocket helper](https://hono.dev/docs/helpers/websocket)
- [itty-router Cloudflare guide](https://itty.dev/itty-router/guides/cloudflare-workers)
- [itty-router performance notes](https://itty.dev/itty-router/performance/speed)
- [itty-fetcher configuration](https://itty.dev/itty-fetcher/configuration)
- [itty.dev ecosystem catalog](https://itty.dev/docs)
- [itty-sockets getting started](https://ittysockets.com/docs/getting-started)

No router, fetcher, socket service, or provider setting was added to the live Worker. The Hono/itty packages are pinned development dependencies for this review only.
