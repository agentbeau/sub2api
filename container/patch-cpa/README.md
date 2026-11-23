# CPA image compatibility checks

The image builder runs this command before compiling CPA. It checks the public
`/v1` and `/v1beta` route registrations against `src/api-routes.ts`, including the
separately attached AI Studio `/v1/ws` relay. It also checks the Gemini wildcard
handler's action cases. The reviewed baseline is CPA v8.0.67.

The check parses Go syntax and compares method/path registrations. Handler body,
comment, formatting, registration order, and unrelated namespace changes do not
alter that route catalog. A changed public route, an unrecognized dynamic
attachment, or a new binary router extension stops the image build with a review
error. Update this catalog and `src/api-routes.ts` together after reviewing the
new upstream behavior; do not bypass the check or pin an entire source file.

The authentication patch rejects an empty effective frontend provider list.
It preserves real provider ordering and authentication, the relay's optional
`ws-auth`, and ephemeral realtime validation. The same fully validated patch plan
adds `frontend_auth_protocol: 1` to the internal lifecycle marker, allowing the
Worker to refuse inference on older images during a mixed rollout.

The Worker's 35-second management-write window may delegate a supplied new key
to an already running CPA before R2 persistence, including the first client key.
That delegation is safe only because **every API forward requires
`frontend_auth_protocol: 1`** and the guarded manager rejects zero effective
providers. Keep the manager regression and Worker capability tests together;
checking stale R2 keys alone cannot protect deletion of the last runtime key.

The tests compile the upstream access manager with a minimal provider boundary
and exercise empty-provider rejection, final-provider removal, and real provider
success. Source fixtures contain the relevant v8.0.67 excerpts, not a substitute
upstream implementation.

When all three opt-in Worker flags for fencing, session-owner routing, and durable
session affinity are enabled, the pinned selector restores explicit
provider/model/session bindings from the existing coordinator Durable Object.
The affinity RPC body carries a SHA-256 digest of the affinity key and the CPA
credential ID plus version metadata; credentials, request bodies, conversation
history, and tool payloads do not. The Worker supplies the stable owning
Durable Object ID from RPC props; the coordinator stores it and rejects reads
or writes from a different session shard. Binding commits use version compare-and-swap before
returning a selected credential to the request executor. Each selected request
advances the version, so a late result callback cannot invalidate a newer
request. A conflict or unknown write outcome fails selection, and the request is
not replayed. Result invalidation is also version checked. The Go HTTP client
performs no retry. A shard mapping change therefore needs an explicit affinity
migration; this patch fails closed when the current DO is not the recorded
owner. This hook intentionally
does not persist LCP fingerprints or provider protocol state and remains disabled
by default; alias/fallback grouping, coordinator load, and expired-record cleanup
still require pool acceptance before raising `max_instances`.

The pinned Home dispatch path asks its external Home control plane to select a
credential and bypasses the local CPA selector. Durable per-session credential
affinity is therefore not established in Home mode. If both Home and the
durable-affinity runtime flag are enabled, the patched selector path returns a
503 before dispatch; it does not guess that Home's session behavior is
equivalent. Home mode remains outside the multi-container readiness claim until
its dispatch contract can enforce and test the same owner and credential fence.

Run from the repository root with a Go compiler:

```sh
go test container/patch-cpa/main.go container/patch-cpa/main_test.go
```
