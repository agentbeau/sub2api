# Rust gateway on Cloudflare

## Goal

Rewrite the public gateway in compiled Rust/WebAssembly, preserve the existing provider container and saved configuration, use Cloudflare's native container lifecycle API, and reduce idle runtime. The active repository is `agentbeau/sub2api`, forked from `PlaygrndLabs/sub2api` at `d7da1f8794830b5e42d921b6e526e5f5ab3a1136`.

## Decisions

- Rust owns request classification, dashboard authentication, session signing/verification, login pages and forwarding policy. Request and response bodies pass through platform streams without copying inference streams into Wasm memory.
- Small TypeScript adapters expose Cloudflare bindings to Wasm. `Cpa` uses `DurableObject` and `ctx.container` directly; the deprecated `@cloudflare/containers` helper is removed.
- CLIProxyAPI remains the compiled Go provider engine inside the container. It owns provider credentials, refreshes, model compatibility, translation, routing, quotas and usage. Moving only some requests around it would change subscription selection and accounting; this rewrite preserves those behaviors. A narrow, build-checked lifecycle patch reports actual background refresh/reload/persistence work through the existing internal HTTP bridge.
- Preserve Worker `sub2api`, class/binding `Cpa`/`CPA`, object name `cf-singleton-container`, migration `v1`, and R2 bucket/binding `sub2api`/`STATE`. Keep the current application scheduling policy; changing it requires a replacement application/namespace.
- Preserve the Workers-only alternative and its `Store` data without migrating or deleting it.
- Use a normal container inactivity timeout of 1,000 ms. The API supports positive values through 21,600,000 ms. Do not keep a lifetime `monitor()` promise or an idle polling wakeup alive. In-flight response streams and WebSockets remain active; inactivity is not a fixed timer since the last request.
- Protect pending OAuth with per-state absolute deadlines because CPA keeps pending sessions and PKCE state in memory. Add 35 seconds of grace after successful management mutations and completed flows. Persist only temporary identifiers/deadlines in the existing Durable Object, preserving these holds across object eviction. Polling must not extend an OAuth deadline.
- Track actual background refresh and asynchronous configuration persistence with internal activity leases: grant before work, renew only while work runs, release after completion. Use the same `cf-singleton-container` through a private Durable Object RPC reached only from the validated `r2.internal` bridge. Never intercept provider HTTPS or add a blanket delay after each model request. Bound each background operation's renewable lifetime and refuse unsafe work if no grant can be obtained.
- Clear old helper alarms during initialization and safely acknowledge an already queued legacy alarm without starting or polling CPA.
- A lightweight gateway liveness endpoint must not wake the provider container. Provider readiness is a separate explicit check.
- Keep all public authentication fail-closed. Existing sessions remain compatible. Never retry a submitted inference request during a cold start; probe readiness before forwarding it.
- CI gates both deployment variants. Deploy only the tested revision. Build and smoke-test the provider image once and deploy that exact image, retaining automatic upstream refresh.

## Performance evidence

Rust runs as Wasm within Cloudflare's existing workerd runtime, not as a separate native Worker runtime. Language alone does not establish speed. Compare the old and new gateway on the same host, include Wasm startup/bundle size, and distinguish CPU microbenchmarks from provider/network latency. Report failed or unavailable live checks explicitly.

## Acceptance

Existing gateway/storage/provider tests remain green; added tests exercise Rust session compatibility, hostile paths, bounded login forms, stream preservation, native cold start coordination, timeout validation, idle-safe liveness, pending OAuth, background activity and migration alarms. Rust builds reproducibly from a locked toolchain/dependency set. Wrangler packages the actual Wasm artifact. Provider hook tests and the exact image smoke are build gates. Remote CI and container smoke checks must pass before claiming deployment readiness.

## References

- https://developers.cloudflare.com/workers/languages/rust/
- https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- https://developers.cloudflare.com/containers/examples/status-hooks/

## Authorization

The user requested the repository update, then specified a faster language/runtime and minimum idle sleep. This authorizes implementation, tests and a durable repository branch/PR. This record does not claim a production deployment has occurred.
