# Multi-container readiness gate

## Current runtime

- The public Worker and Access-authenticated browser route both dispatch to the stable Durable Object name `cf-singleton-container`. `wrangler.jsonc` keeps `max_instances: 1`.
- CPA v8.0.67 selects provider credentials and performs OAuth/token refresh internally. Its session-affinity selector and refresh mutex/cache are process-local. CPA config and credential records are persisted through the R2 S3 bridge; local container disk is not durable across sleep/restart.
- The Worker OAuth lease stores only pending-state identifiers and idle deadlines so that the singleton stays awake during a flow. It does not transfer PKCE verifier/session state or the callback to a second CPA process. OAuth start/callback routing therefore remains singleton-only.
- Background activity callbacks now carry the calling Durable Object ID as WorkerEntrypoint RPC props and route back to that exact DO. Missing or malformed IDs fail closed; the bridge no longer aliases all activity leases to the singleton.
- The S3 bridge now passes `If-Match` and `If-None-Match` on `PutObject` to [R2's atomic conditional-write API](https://developers.cloudflare.com/r2/api/s3/conditional-operations/) and returns `412 PreconditionFailed` for conflicts. CPA's pinned Go client still emits unconditional writes, so this capability does not yet fence auth/config persistence across containers. Its file token store and refresh coordination remain process-local.

The callback route now follows the owning DO and R2 can reject explicitly conditional writes, but neither change alone establishes credential ownership. Simply changing `max_instances`, hashing a request header, or adding a second named container could still split an OAuth exchange, refresh one credential concurrently, or race CPA's unconditional auth/config writes. The app therefore remains on one container until CPA's selected credential identity, refresh execution, OAuth verifier/callback state, and every shared write carry the same enforceable owner/fence.

## Preparation in this branch

`src/pool-coordination.ts` contains atomic lease, fencing epoch, OAuth callback-owner, stable session-placement and versioned shared-state compare-and-swap primitives. Its tests cover concurrent claim exclusion (including same-owner re-entry), explicit lease renewal, stale-owner rejection, session affinity, callback routing, restart takeover, write conflicts, conflicting callback binds and writes delayed past lease expiry. Every lease decision reads the injected clock inside the storage transaction so queue delay cannot extend an owner's rights. The callback activity path is now wired per container DO and tested through workerd; optional S3 write preconditions are exercised against the workerd R2 binding. CPA still needs refresh ownership/fencing in its Go path and conditional writes from the Go object-store client. These changes are safe preparation, not an enabled multi-container runtime.

## Required integration before raising `max_instances`

1. Keep a single integrated Worker and use explicit, stable session identity for affinity; never route based on guessed provider, ingress API key, or call type alone.
2. Make CPA's selected upstream credential ID available to a central ownership coordinator and fence foreground and background refreshes with a monotonic generation. A stale process must be unable to persist a refreshed credential after takeover.
3. Route OAuth start and callback by durable opaque state ownership, and make ownership recoverable or explicitly fail closed across process crash/restart. Do not claim to resume an in-flight authorization code exchange from a new process unless CPA persists the necessary verifier/session state.
4. Change shared credential/config writes in CPA's Go object-store client to conditional, fenced writes, or keep one writer for the shared R2 keyspace. Add conflict and ambiguous-replay tests against the exact CPA/R2 write path; the edge bridge's new conditional-write support alone is not that proof.
5. Drain active streams before changing owner, never retry after output or tool side effects have been delivered, and verify zero active work before shutdown. Keep conversation/tool execution state separate from provider session affinity.
6. Test the exact Worker/container pair cold and warm, with concurrent refresh, OAuth start/callback, restart takeover, write contention, streaming and cancellation. Only then consider an increase above one.

The container pool is not enabled by this PR. No billing, OAuth, or provider-account semantics are changed.

The prepared production deploy now rejects a container artifact unless the existing `Cpa` class has `max_instances: 1`, before image push or R2/Worker writes. The existing isolated-preview guard independently compares its complete container configuration to the one-instance allowlist. Tests cover a three-instance artifact failing before any external writes.
