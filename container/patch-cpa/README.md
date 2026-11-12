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

Run from the repository root with a Go compiler:

```sh
go test container/patch-cpa/main.go container/patch-cpa/main_test.go
```
