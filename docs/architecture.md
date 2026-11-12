# Rust gateway on Cloudflare

## Goal

Rewrite the public gateway in compiled Rust/WebAssembly, preserve the existing provider container and saved configuration, use Cloudflare's native container lifecycle API, and reduce idle runtime. The active repository is `agentbeau/sub2api`, forked from `PlaygrndLabs/sub2api` at `d7da1f8794830b5e42d921b6e526e5f5ab3a1136`.

## Decisions

- Rust owns request classification, forwarding policy and dashboard access decisions. In the deployed Cloudflare Access mode, the TypeScript edge validates platform-owned `ctx.access.aud` and carries that verified decision through private `fetchWithAccess` RPC; caller-supplied headers and legacy password cookies cannot authorize browser routes. Password session signing/verification remains available outside Access mode. See [dashboard sign-in](dashboard-access.md). Request and response bodies pass through platform streams without copying inference streams into Wasm memory.
- Small TypeScript adapters expose Cloudflare bindings to Wasm. `Cpa` uses `DurableObject` and `ctx.container` directly; the deprecated `@cloudflare/containers` helper is removed.
- CLIProxyAPI remains the compiled Go provider engine inside the container. It owns provider credentials, refreshes, model compatibility, translation, routing, quotas and usage. Moving only some requests around it would change subscription selection and accounting; this rewrite preserves those behaviors. A narrow, build-checked lifecycle patch reports actual background refresh/reload/persistence work through the existing internal HTTP bridge.
- Preserve Worker `sub2api`, class/binding `Cpa`/`CPA`, object name `cf-singleton-container`, migration `v1`, and R2 bucket/binding `sub2api`/`STATE`. Keep the current application scheduling policy; changing it requires a replacement application/namespace.
- Preserve the Workers-only alternative and its `Store` data without migrating or deleting it.
- Use a normal container inactivity timeout of 1,000 ms. The API supports positive values through 21,600,000 ms. Do not keep a lifetime `monitor()` promise or an idle polling wakeup alive. In-flight response streams and WebSockets remain active; inactivity is not a fixed timer since the last request.
- Protect pending OAuth with per-state absolute deadlines because CPA keeps pending sessions and PKCE state in memory. Add 35 seconds of grace after successful management mutations and completed flows. Persist only temporary identifiers/deadlines in the existing Durable Object, preserving these holds across object eviction. Polling must not extend an OAuth deadline.
- Track actual background refresh and asynchronous configuration persistence with internal activity leases: grant before work, renew only while work runs, release after completion. Use the same `cf-singleton-container` through a private Durable Object RPC reached only from the validated `r2.internal` bridge. Never intercept provider HTTPS or add a blanket delay after each model request. Bound each background operation's renewable lifetime and refuse unsafe work if no grant can be obtained.
- Clear old helper alarms during initialization and safely acknowledge an already queued legacy alarm without starting or polling CPA.
- A lightweight gateway liveness endpoint must not wake the provider container. Provider readiness is a separate explicit check.
- Serve the exact tested native console directly from `STATE/dashboard/management.html` at the edge. There is no wrapper, countdown or Start/Extend/Close controls UI. Static HTML does not start CPA. After dashboard authentication, native management requests with a supplied management credential can use native startup; CPA validates the key, so a wrong management key can wake it before rejection. The old same-origin `/runtime/start` and `/runtime/stop` endpoints retain their two-minute editing hold only for legacy clients; the current console does not use them. `/runtime/status` does not start CPA or renew a hold.
- Admit ordinary client keys from current R2 configuration before invoking the lifecycle. Keep CPA's header/query matching, YAML semantics and pending-import precedence. Never probe CPA to discover whether keys exist. Preserve native startup for enabled authentication plugins whose effective policy cannot be determined outside their runtime.
- Use a separate `forwardExisting` readiness path for management requests without a credential, passive same-origin console model catalogs, callbacks and temporary credentials that cannot survive a process loss. It has no call to native start, checks process state across asynchronous setup races, and cannot become the startup promise used by accepted model requests. A valid inference request still uses the original native startup path and forwards once.
- Preserve issued realtime credentials until their absolute native expiry, with only a numeric deadline stored. These credentials live in the provider's memory and are reusable until expiry; ordinary one-second idle must not erase them before use. Clear their hold only after confirmed process loss or expiry.
- Patch the effective frontend authentication manager to reject zero providers. Require the separate `frontend_auth_protocol: 1` capability before any API forwarding, including during mixed-image rollouts. Saved R2 keys alone cannot detect a just-deleted last runtime key or a failed authentication plugin.
- Parse native Go route registrations, relay attachments and Gemini action cases during image builds. Stop an incompatible update before publication so a new upstream endpoint cannot be silently blocked by the gateway catalog.
- Brand dashboard literal values and product artwork at build time, with structural and JavaScript syntax checks. Preserve native protocol discriminators, provider artwork and license notices. Adapt public metadata header names together with panel readers, retaining native response streams and upgrade handles.
- Keep all public authentication fail-closed. Legacy password sessions remain compatible only outside configured Access mode; Access mode requires the matching verified platform identity. Never retry a submitted inference request during a cold start; probe readiness before forwarding it.
- CI gates both deployment variants. Deploy only the tested revision. Build and smoke-test the provider image once and deploy that exact image, with the provider default pinned to v8.0.67 and explicit reviewed upgrades through `CPA_VERSION`.

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
