# Multi-container readiness gate

## Current runtime

- The public Worker and Access-authenticated browser route both dispatch to the stable Durable Object name `cf-singleton-container`. `wrangler.jsonc` keeps `max_instances: 1`.
- CPA v8.0.67 selects provider credentials and performs OAuth/token refresh internally. Its session-affinity selector and refresh mutex/cache are process-local. CPA config and credential records are persisted through the R2 S3 bridge; local container disk is not durable across sleep/restart.
- OAuth start binds the opaque state to its originating Durable Object, and callback ingress resolves that owner. This routes a callback to the same object but does not make CPA's in-memory PKCE verifier or provider session transferable across a container restart.
- Background activity callbacks carry the calling Durable Object ID as WorkerEntrypoint RPC props. Refresh work acquires a credential-specific lease with an epoch and renews it while running. Missing or malformed owner information fails closed.
- With `POOL_FENCING_ENABLED=true`, the pinned CPA Go object store acquires a per-object Worker lease and uses R2 conditional `PUT` with the ETag loaded at bootstrap or returned by its prior write. Config and auth writes reject unknown bases and conflicts. Fenced deletes write a conditional zero-byte tombstone because R2 does not expose conditional `DeleteObject`; empty auth objects are skipped by CPA's loader. The R2 S3 bridge enforces the same lease at the write boundary. See [R2's atomic conditional-write API](https://developers.cloudflare.com/r2/api/s3/conditional-operations/) and [Workers API `onlyIf`](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

These hooks establish fencing for refresh execution and shared object writes when explicitly enabled. They do not yet provide durable session-to-owner placement or make CPA's in-memory affinity, PKCE verifier, or provider protocol state restartable. The live application therefore remains on one container with fencing off until the routing and restart gates below are completed and tested.

## Preparation in this branch

`src/pool-coordination.ts` contains atomic lease, fencing epoch, OAuth callback-owner, session-placement primitive and versioned shared-state compare-and-swap support. Edge tests cover concurrent claim exclusion, renewal, stale-owner rejection, session affinity, callback routing, restart takeover, write conflicts, conflicting callback binds and writes delayed past lease expiry. The CPA patch wraps synchronous and background refreshes in per-credential ownership and routes their activity renewal through the owning DO. Its Go object-store patch uses key-specific fencing and conditional writes. Tests cover stale ETags, create-only writes, concurrent writers, a committed write whose response is lost (with no replay or ETag rebase), tombstones, callback ownership and actual workerd R2 conditions. The flag remains off and these changes do not yet route user sessions among containers.

## Required integration before raising `max_instances`

1. Keep a single integrated Worker and use explicit, stable session identity for affinity; never route based on guessed provider, ingress API key, or call type alone.
2. Integrate durable session-to-owner assignment with CPA's selected credential and session-affinity behavior. The current `sessionShard` helper is not wired into dispatch and is not an authorization decision.
3. Keep OAuth callback ownership bound to the start owner and explicitly fail closed if that owner's CPA process lost its verifier/session state. Do not claim to resume an in-flight authorization code exchange from a new process.
4. Preserve the new fenced Go writes in CI and add end-to-end tests against the exact Worker/R2 bridge pair, including unknown outcomes. Go tests simulate a conditional S3 server; one commits then drops the response to prove the CPA client neither replays nor rebases. The edge runtime test separately exercises real workerd R2 conditions.
5. Drain active streams before changing owner, never retry after output or tool side effects have been delivered, and verify zero active work before shutdown. Keep conversation/tool execution state separate from provider session affinity.
6. Test the exact Worker/container pair cold and warm, with concurrent refresh, OAuth start/callback, restart takeover, write contention, streaming and cancellation. Exercise only supported provider routes; Nathan's Claude, Gemini and OSS models use Antigravity OAuth and are excluded from live tests here.

The container pool is not enabled by this PR. No billing, OAuth, or provider-account semantics are changed.

The prepared production deploy now rejects a container artifact unless the existing `Cpa` class has `max_instances: 1`, before image push or R2/Worker writes. The existing isolated-preview guard independently compares its complete container configuration to the one-instance allowlist. Tests cover a three-instance artifact failing before any external writes.
