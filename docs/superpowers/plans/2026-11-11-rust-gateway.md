# Rust Gateway Implementation Plan

> For agentic workers: use bounded implementation ownership and independent final review. Track verification here.

**Goal:** Deliver a Rust gateway, native container lifecycle with one-second idle timeout, and tested continuous deployment.

**Architecture:** Rust/Wasm implements the public gateway. TypeScript only connects platform APIs. The existing Go CPA container and R2 state remain authoritative for provider execution.

**Tech stack:** Rust 1.99.1, wasm-bindgen, Cloudflare Workers/Wasm, native Container API, existing Wrangler 4.149.0, Go CPA image.

**Spec:** `docs/architecture.md`

## Global constraints

Preserve `sub2api`, `Cpa`, `CPA`, `cf-singleton-container`, `v1`, and `STATE`. No destructive migration, new credential store, scheduling-policy change or invented provider speed claim. Keep inference bodies streaming and preserve session signatures. Default idle timeout 1,000 ms.

## Review focus

Expired/forged sessions and chunked oversized login forms; WebSocket and SSE forwarding; concurrent startup without duplicate inference; reused container after DO eviction; deployment revision/image mismatch and fork workflow safety.

## Task 1: Rust gateway

Owned files: `gateway-rs/**`, `src/gateway.ts`, `src/routes.ts`, `src/wasm.ts`, `test/gateway.test.ts`.

- [x] Write Rust behavioral tests for route boundaries and byte-compatible session signatures; observe failure before implementation.
- [x] Implement the existing `handle(request, config, forward): Promise<Response>` contract through Rust, retaining TypeScript binding interfaces only.
- [x] Preserve current gateway behavior and add stream/form/session regression coverage.
- [x] Run Rust tests plus the existing gateway suite against the compiled Wasm.

## Task 2: Native container lifecycle

Owned files: `src/cpa.ts`, `src/env.ts`, `src/index.ts`, new lifecycle/R2 bridge modules and lifecycle tests, `wrangler.jsonc`.

- [x] Reproduce cold-start concurrency, readiness, timeout and stream lifetime requirements in tests.
- [x] Replace helper class with native `ctx.container`, intercept `r2.internal`, enable Internet explicitly, retain singleton identity and import behavior.
- [x] Configure one-second normal inactivity with no lifetime monitor; use explicit readiness probing before one-time inference forwarding.
- [x] Provide non-waking `/healthz` plus explicit provider `/readyz`; pass targeted tests and typecheck.
- [x] Drain persisted alarms from the previous helper during an in-place upgrade.
- [x] Protect pending OAuth and asynchronous state persistence with bounded leases, and verify refresh behavior before short idle shutdown.

## Task 3: Build and continuous deployment

Owned files: `.github/workflows/**`, `test/container-smoke.sh`, deployment/image scripts.

- [x] Gate both variants on successful CI for the exact default-branch revision; serialize writes to the shared Worker.
- [x] Install pinned Rust/Wasm tooling, build the compiled gateway before checks/deployment.
- [x] Implement build-once image smoke and immutable-image deployment; keep scheduled upstream refresh. Actual Docker execution remains a CI gate.
- [x] Check workflow validity and deployment script behavior.
- [ ] Pass actual branch CI, including the exact Docker image smoke test.

## Task 4: Integration and delivery

Parent-owned: package/build/test configuration, generated types, documentation, benchmarks, repository publishing.

- [x] Baseline: `npm run verify` passed 254 tests before edits.
- [x] Build Rust/Wasm reproducibly and run `npm run verify`, Rust tests, meaningful workerd integration, and Wrangler dry-run.
- [x] Compare original and compiled gateway CPU paths; report speedups, regressions, final deployment module sizes and measurement limits in `docs/performance.md`.
- [x] Independent final review; fix material findings and rerun affected checks.
- [ ] Commit and push branch, create reviewable PR, inspect remote CI, and state production status precisely.

## Progress and decisions

- Baseline commit: `d7da1f8794830b5e42d921b6e526e5f5ab3a1136`; clean fresh checkout on `feat/rust-cloudflare-gateway`.
- Baseline verification: typecheck, lint and all 254 tests passed.
- Native scheduling replacement is excluded because it would replace the application's namespace.
- Rust is a measured gateway rewrite; provider execution remains CPA to preserve model support, credential priority and usage accounting.
- Rust unit tests: 8 passed. The final integrated suite passed 383 tests in 25 files, plus typecheck and lint.
- Actual workerd smoke passed Wasm loading, login/session compatibility, non-waking liveness, a 2 MiB upload, delayed SSE, native WebSocket forwarding, and the actual private WorkerEntrypoint-to-Durable-Object RPC wiring. The prepared deployment bundle passed the same runtime checks.
- Deployment safeguard tests: 13 passed. Actionlint 1.7.12 accepted all four workflows. Both source and prebuilt Wrangler packaging modes passed for both installations.
- Independent review found that pending OAuth lives in CPA memory and that configuration persistence continues after HTTP acknowledgement. Bounded OAuth and actual-work leases now cover those paths. Additional regressions cover concurrent sign-ins, old helper alarms, mixed-version image rollout, object eviction without public traffic, and stale temporary holds after confirmed process loss.
- The reviewer independently passed 108 focused lifecycle/OAuth/activity tests, the Go patcher tests and fresh Go helper race tests. No remaining material source-code finding was identified; exact-image CI remains required before merging.
- The final Go patch applied to all six expected files in CPA v8.0.67 (`8bba7a77c6bcbfd993516d26606bfecaa4ff49d0`). The full patched provider compiled under Go 1.26.10. Ten helper tests passed under the race detector and three behavioral patcher tests passed.
- A local compiled-provider integration held a real configuration PUT for 2,241 ms with continuous protection: six grants, six releases, no rejected grants, and no active jobs remaining. A fresh process with a fresh local spool restored the saved client key from the S3 fixture; a wrong key was rejected and plaintext management credentials were absent from saved configuration. This is not an actual Docker image or live Cloudflare test.
- Docker is unavailable locally. No production Worker or container application named sub2api was found in the connected Cloudflare account, and no production deployment or destructive migration was performed.
