# Durable Object scheduling lab

This is an **unprovisioned, non-public replacement Worker**, not an in-place
upgrade and not a production cutover. Existing Worker configurations and state
are unchanged. Do not deploy the default configuration to try this lab.

## Implemented

- `wrangler.scheduler.jsonc` selects the `durable_object` policy, a separate
  `ScheduledEngine` class/namespace and a separate, not-yet-created R2 bucket.
- The named `engine` image is digest-pinned. The replacement class selects it at
  each cold start. Existing classes still use their original scheduling behavior.
- Startup rejects non-singleton IDs and missing/unpinned images. The Worker
  routes only to the fixed singleton; no request chooses an image, ID or size.
- Readiness probes, streaming, native inactivity handling, R2 interception and
  activity/OAuth/realtime holds reuse the existing lifecycle implementation.
- The replacement R2 bridge explicitly uses the new ENGINE binding, including
  deferred activity callbacks.
- Public URLs are disabled and the Access audience is an invalid placeholder.
  No credentials are included. Even accidental activation fails closed.

## Important differences

The beta policy does not support `basic` or `max_instances`. `lite` is selected
as the initial test candidate, not as proof of equivalent memory capacity. The
one-instance boundary is enforced by the fixed namespace ID at startup. Account
limits still apply. Live startup, workload memory, long responses, sleep and cost
must be measured before choosing a production instance size.

Images do not roll out across running instances automatically. This lab does not
kill an active instance when Worker code changes; a new pinned image takes effect
on the next natural cold start. Explicit replacement must first drain active work.

## Activation and acceptance

1. Pass full CI for this exact revision, including the generated Rust/Wasm gateway.
   The separate lab has no automatic Cloudflare build/deploy trigger.
2. Provision only the lab bucket and owner-only Access identity, with the relevant
   security approval. Use fresh lab credentials, never copy live account tokens
   or point two writers at an existing gateway bucket.
3. Dry-run then deploy **only** `wrangler.scheduler.jsonc`. Confirm the new
   application reports `durable_object` and the expected class/image. Enable the
   owner-gated route only after the policy and platform audience are verified.
4. Verify cold start, authentic management request, text/image requests with
   authorized test accounts, R2 persistence, overlapping streams, deferred writes,
   idle sleep, and subsequent wake. Check unauthorized requests and arbitrary IDs
   cannot start additional containers.

No cutover is implied. The active preview now contains user changes. A later
cutover needs a single-writer transfer, reconciliation of external R2 state and
a fresh replacement DO namespace; live OAuth sessions and leases are not copied.
Retain old resources for rollback. Never delete a namespace merely to migrate.

## Verification so far

Focused lifecycle/config tests and targeted lint run locally. Wrangler 4.149.0
accepts the configuration in `--dry-run --no-bundle`; that does not build or
validate the executable bundle. Full local typecheck/build is blocked by missing
generated `gateway-rs/pkg` and Rust/wasm-bindgen tools. Live behavior is untested.

## Official references

- https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/guides/image-management/
