# Multi-container readiness gate

## Current runtime

- The public Worker and Access-authenticated browser route both dispatch to the stable Durable Object name `cf-singleton-container`. `wrangler.jsonc` keeps `max_instances: 1`.
- CPA v8.0.67 selects provider credentials and performs OAuth/token refresh internally. Its session-affinity selector and refresh mutex/cache are process-local. CPA config and credential records are persisted through the R2 S3 bridge; local container disk is not durable across sleep/restart.
- The Worker OAuth lease stores only pending-state identifiers and idle deadlines so that the singleton stays awake during a flow. It does not transfer PKCE verifier/session state or the callback to a second CPA process. Background activity callbacks also target the singleton.
- CPA's file token store serializes writes only within one process. R2Bridge exposes the S3-compatible object store; writes from different CPA processes are not fenced or compare-and-swapped by the Worker.

These boundaries mean simply changing `max_instances`, hashing a request header, or adding a second named container could split an OAuth exchange, refresh one credential concurrently, race an R2 write, or misroute a background-activity lease. The app therefore remains on one container until ownership is enforced at the provider credential selection, refresh, callback, and shared write paths.

## Preparation in this branch

`src/pool-coordination.ts` contains atomic lease, fencing epoch, OAuth callback-owner, stable session-placement and versioned shared-state compare-and-swap primitives. Its tests cover concurrent claim exclusion (including same-owner re-entry), explicit lease renewal, stale-owner rejection, session affinity, callback routing, restart takeover, write conflicts, conflicting callback binds and writes delayed past lease expiry. Every lease decision reads the injected clock inside the storage transaction so queue delay cannot extend an owner's rights. CPA still needs an owner-local refresh mutex around each credential and a unique owner ID per process boot. These primitives are intentionally not connected to production request routing, CPA's Go refresh code, or the R2 S3 write path; the tests validate the primitive only, not an operating multi-container deployment.

## Required integration before raising `max_instances`

1. Keep a single integrated Worker and use explicit, stable session identity for affinity; never route based on guessed provider, ingress API key, or call type alone.
2. Make CPA's selected upstream credential ID available to a central ownership coordinator and fence foreground and background refreshes with a monotonic generation. A stale process must be unable to persist a refreshed credential after takeover.
3. Route OAuth start and callback by durable opaque state ownership, and make ownership recoverable or explicitly fail closed across process crash/restart. Do not claim to resume an in-flight authorization code exchange from a new process unless CPA persists the necessary verifier/session state.
4. Change shared credential/config writes to conditional, fenced writes, or keep one writer for the shared R2 keyspace. Add conflict and replay tests against the real object bridge.
5. Drain active streams before changing owner, never retry after output or tool side effects have been delivered, and verify zero active work before shutdown. Keep conversation/tool execution state separate from provider session affinity.
6. Test the exact Worker/container pair cold and warm, with concurrent refresh, OAuth start/callback, restart takeover, write contention, streaming and cancellation. Only then consider an increase above one.

The container pool is not enabled by this PR. No billing, OAuth, or provider-account semantics are changed.
