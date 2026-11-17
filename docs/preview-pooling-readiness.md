# Preview container-pooling readiness

## Current boundary

The user-facing gateway remains one integrated Worker. The current preview sends every provider request to the named `cf-singleton-container` Durable Object; live Cloudflare state still sets the container application's `max_instances` to `1`. The ownership-fencing feature flag is not enabled in the live preview.

Cloudflare assigns each container instance to one Durable Object. More instances require the Worker to address more named objects and choose an owner for each request; increasing `max_instances` alone does not add an application router. See [Cloudflare scaling and routing](https://developers.cloudflare.com/containers/configuration/scaling-and-routing/).

## Route by upstream identity

Any internal pool router must use the selected upstream provider, actual provider credential/account type, protocol, and a stable session identity. A gateway API key authenticates the caller; it does not identify which upstream credential CPA will select. Keep CPA's current credential selection, priority, quota, exclusion, and endpoint behavior intact until the edge can establish the selected upstream identity.

Keep CLI/OAuth traffic on the container path that owns its provider session. A direct Worker API-key path is eligible only when the selected upstream account really uses an API key and that exact provider endpoint and mode are implemented. The experimental `worker/` implementation is a separate, incomplete alternative, not proof of compatibility for all image, video, speech, or Responses requests.

The pinned CLIProxyAPI v8.0.67 source includes `routing.session-affinity`, a TTL, and `rebind-on` policies. Its session-to-credential cache is held inside each CPA process, so it does not persist ownership across containers or process restarts. Reuse it for credential selection inside an owner; add a durable owner mapping above it before distributing sessions.

## State and continuity requirements

- Persist a stable session-to-Durable-Object owner mapping and connect it to dispatch. The current `sessionShard` function is a placement primitive only; the request router still uses the singleton.
- Route each container's background-activity callback to its own Durable Object. `Cpa` stores OAuth, realtime, management, and background leases in that object's storage. Refreshes can use credential-specific leases, and OAuth callbacks are routed by state to the owner object. CPA's verifier and provider session remain process-local.
- Treat shared R2 provider-state writes as concurrent state changes. Under the feature flag, CPA's patched Go object store acquires a per-key owner lease and uses atomic conditional `PUT` with the ETag it loaded. The bridge rejects missing or stale fencing data. Fenced deletes use empty conditional tombstones because R2 conditional `DeleteObject` is unavailable.
- Keep an active stream on its original owner through EOF or cancellation. Do not migrate an in-flight stream. Retry only before a provider request is submitted or when protocol preflight proves no output or side effect was committed. After submission, keep the existing `runtime_outcome_unknown` result and do not replay automatically.

The pinned [OpenCodex stream preflight](https://github.com/lidge-jun/opencodex/blob/311105ef0e842ffe439156033eeefb7895f524ed/src/server/responses/combo-stream-preflight.ts) and [codex-lb continuity checks](https://github.com/Soju06/codex-lb/blob/72630bbfeee9e3b0d9acfb95e2b1e706b8b0188e/app/modules/proxy/continuity.py) are reference patterns for preserving the semantic retry boundary and distinguishing account-neutral recovery from session-bound state; neither by itself supplies this project's ownership protocol.

## Activation and cost gates

Leave the preview at one container until session-owner dispatch, per-owner leases and callbacks, provider-account selection, concurrent R2 writes, failover, and rollback have integration coverage. The code in this branch adds refresh/callback/write fencing but does not enable multi-container dispatch; the live preview remains on its existing Worker/container pair. Before enabling a pool, test cold readiness, explicit and implicit effort, long streaming, client cancellation, and account continuity through the protected preview.

Do not keep three instances running continuously. Cloudflare bills container CPU, memory, and disk while instances are active and stops charges after they sleep; on-demand owners can scale to zero. The actual cost depends on the number of active owners, instance sizes, and runtime, not merely the configured pool size. See [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

Do not run live Antigravity OAuth tests through this gateway. Nathan identified his Claude, Gemini and OSS model routes as using Antigravity OAuth; treat them as excluded from real-provider testing here. [Google's Antigravity terms, clause 6](https://antigravity.google/terms) prohibit third-party software or services from accessing Antigravity and identify suspension or termination as possible consequences.
