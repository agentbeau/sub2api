# Isolated Worker preview

Status: preparation only. No preview deployment or shared-state migration is implied by this branch.

Production keeps `wrangler.jsonc`, its existing main-only Cloudflare Builds entrypoint, domain,
container and `sub2api` R2 bucket unchanged. Do not weaken those guards to run a preview.

The new `wrangler.preview.jsonc` uses `src/preview.ts`, which checks the verified platform
`ctx.access.aud` before **every** route. A missing preview identity returns 403 without calling
the gateway. This is additional protection, not a replacement for an owner-only Access policy.

## Required provisioning before activation

1. Create a preview-only owner Access application for this Worker's previews. Keep production
   policies unchanged. Set its new audience in both preview `ACCESS_AUD` and `PREVIEW_ACCESS_AUD`.
   This configuration change requires the applicable security-settings approval.
2. Create a blank private bucket `sub2api-preview-isolated`. Do not copy provider auth files,
   production client keys, pending imports or dashboard sessions. Set a new preview-only
   management secret through Wrangler's preview-secret interface, never Git or plain vars.
3. Configure separate commands `node scripts/preview-builds.mjs build` and
   `node scripts/preview-builds.mjs deploy`, with `SKIP_DEPENDENCY_INSTALL=1`. The executor
   must have the pinned Rust/wasm-bindgen tools (see existing CI setup) and Docker. The
   entrypoint fails preflight without them. It builds and verifies source token-free, smoke-tests
   the exact image, packages and probes the compiled preview, then records checksummed artifacts.
   Deploy verifies that same build receipt, loads/pushes only the tested image, publishes its
   dashboard only to the preview bucket, and invokes `wrangler preview` using its image digest.
   It never runs the production deploy script or recompiles upstream code with deployment credentials.
4. Run `WORKERS_CI_BRANCH=dagul/isolated-worker-preview node scripts/preview-guard.mjs` before
   provisioning/deploying. It intentionally fails while the owner audience is unconfigured.
   Restrict automatic activation to this branch in the new entrypoint. Only then configure
   Cloudflare Preview Builds, leaving production build settings unchanged.

## State and costs

Worker Previews creates separate Cpa Durable Object namespaces and container applications.
It does not automatically isolate R2. Both CPA engines using the production bucket could
refresh or overwrite the same saved state, and consume pending imports independently.
Never use the production bucket for simultaneous writers. A future single-writer cutover is
separate work, not part of preview activation.

This preview is bounded to one `basic` container and a 1-second normal idle timeout. That is
not a dollar cap. Builds, container runtime, DO and storage usage remain metered. Check actual
account remaining allowances before running repeated builds; do not describe it as free.
Container preview support is partial. Verify startup, an authenticated test using only synthetic
or separately authorized test credentials, idle sleep, and unauthorized 403s before sharing.
After deletion inspect for leftover preview container applications; deletion may not remove them.

## Verification

`node --test scripts/preview-guard.test.mjs`
`npx vitest run test/preview-access.test.ts`

These focused checks are not a full build or deployment test. The existing full repository CI
also runs on the draft pull request. GitHub and Cloudflare build success must be checked at the
same source revision before claiming automatic preview deployment works.

## Official sources

- https://developers.cloudflare.com/workers/previews/resources/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/

## Provisioning record

Blank private R2 bucket `sub2api-preview-isolated` created November 12, 2026. No production objects or credentials copied. Access application, secrets, and Builds activation remain pending.

Builds pricing: Paid plans include 6,000 minutes/month, then $0.005/minute. See https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ . The account availability API returned an empty result, so remaining allowance is unverified.

## Verified Access provisioning, 2026-11-12

Owner approved the separate preview rule. Created `sub2api private previews` for only
this Worker’s preview deployments. All paths require Nathan’s email AND membership
in the Cloudflare account; app and policy sessions are 24 hours. Its audience is wired
into preview config. Existing production API console app and owner policy were already
24 hours and remain unchanged. No bypasses were added.

CI run 43326430721 passed both Worker and container jobs, including compiled-preview
forged-identity denial probes. Preview deployment is still inactive: the documented
Cloudflare build image does not list Rust, wasm-bindgen or Docker. The independent
source-building pipeline must not be activated until that prerequisite is proven or
replaced by a verified CI-artifact consumer. Passing CI is not proof of live deployment.
