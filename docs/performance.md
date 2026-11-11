# Gateway performance measurements

The Rust rewrite substantially reduces local dashboard authentication and login CPU time. Its plain API forwarding path adds a small Wasm boundary cost. These measurements do not establish faster model generation, production network latency, Cloudflare billed CPU, or a particular cost reduction.

## Method

Measured on 2026-11-11 using Node.js v24.22.1, Linux x64, on an AMD EPYC 9V74 host. The original gateway comes from commit `d7da1f8794830b5e42d921b6e526e5f5ab3a1136`. The new gateway uses the actual release Wasm compiled with Rust 1.99.1 and wasm-bindgen 0.2.130.

The benchmark imports both implementations into the same Node/V8 process, warms each case with 300 requests, then measures five rounds of 2,000 requests per implementation. The execution order alternates each round. Results below are medians of those rounds and include request/response construction. External provider forwarding and the warm key guard are controlled local callbacks. Authentication uses the same valid legacy session cookie in both implementations.

All samples, environment metadata and the exact measurement time are in [the raw report](performance-2026-11-11.json). Timing variation between rounds is visible there. This is a local microbenchmark, not a confidence interval or a Cloudflare production load test.

## Results

| Gateway operation | Original TypeScript | Rust/Wasm | Observed change |
|---|---:|---:|---|
| Authenticated dashboard request | 152.60 µs | 14.32 µs | 10.65× faster |
| Successful dashboard login | 189.09 µs | 36.23 µs | 5.22× faster |
| API forwarding with warm key guard | 23.62 µs | 28.30 µs | 4.67 µs slower, about 20% more local overhead |
| Rejected unknown path | 6.83 µs | 9.95 µs | 3.13 µs slower |

Rust performs HMAC/SHA-256 session work synchronously in Wasm. Platform request handling still crosses the JavaScript/Wasm boundary. The implementation keeps provider uploads and replies as native streams and returns the native forwarding promise where possible; it does not copy inference bodies into Wasm.

The Rust module is **198,471 bytes** before compression. A single module-import observation was 0.62 ms for the original gateway and 3.30 ms for Rust. A single Node module import is not a reliable production cold-start measurement; it only makes the added initialization work visible.

The complete Wrangler deployment modules include the new native lifecycle, activity protection and Rust glue, as well as the gateway itself:

| Deployment modules | Original | Updated |
|---|---:|---:|
| JavaScript | 285,529 bytes | 267,730 bytes |
| Wasm | — | 198,471 bytes |
| Total uncompressed | 285,529 bytes | 466,201 bytes |
| Sum of individually gzipped modules | 66,131 bytes | 121,359 bytes |

These are the actual Wrangler dry-run outputs, with gzip calculated locally using a fixed timestamp. They exclude source maps and are not a measurement of Cloudflare's internal distribution format. The updated deployment is larger overall, even though its JavaScript module is smaller. Treat that size and initialization increase as a tradeoff against the authentication CPU improvements and fewer object round trips.

## Architecture effects outside this benchmark

The public Worker now answers liveness, login, logout, home redirects and rejected paths without a Durable Object round trip. The old public Worker sent every request through the container's object. This removes an unnecessary hop and avoids waking that object for those local routes; the benchmark above does not measure that network effect.

The provider container uses the native inactivity timer with a one-second normal idle setting. Pending OAuth flows, recent state mutations and actual background refresh or persistence work temporarily extend that timeout, because CPA performs some work after sending its HTTP response. During a mixed-version rollout, an old image retains a conservative timeout until the new activity protocol is confirmed. Completed sign-ins and saved provider credentials remain in the existing R2 store. Detailed lease behavior is described in the README.

Shorter idle periods can reduce unused container runtime. They also increase the chance of a cold start between requests. A container restart still starts CPA and reloads its provider state; rewriting gateway policy cannot eliminate that cost. The Go provider engine is retained, so this change makes no claim that inference or provider token exchange runs faster.

Cloudflare runs Rust as Wasm inside the Workers runtime. It does not offer this deployment a separate native Rust server runtime. See [Cloudflare's Rust documentation](https://developers.cloudflare.com/workers/languages/rust/) for the platform model and Wasm overhead considerations.

## Reproduce

Install the pinned build tools described in the README, then prepare a clean copy of the original revision:

```bash
mkdir /tmp/sub2api-original
git archive d7da1f8794830b5e42d921b6e526e5f5ab3a1136 | tar -x -C /tmp/sub2api-original
npm run build
node scripts/benchmark-gateway.mjs /tmp/sub2api-original /tmp/gateway-benchmark.json
```

Run on an otherwise quiet machine. Keep the baseline revision, runtime and toolchain fixed when comparing changes. Run `npm run test:runtime` separately for workerd behavior; Docker image smoke and an installed Cloudflare deployment are required to assess real container startup, idle shutdown and provider access.
