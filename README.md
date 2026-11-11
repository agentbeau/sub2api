# sub2api: Rust gateway on Cloudflare

[![ci](https://github.com/agentbeau/sub2api/actions/workflows/ci.yml/badge.svg)](https://github.com/agentbeau/sub2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A **Rust/WebAssembly gateway on Cloudflare Workers**, with the upstream [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) provider engine in a Go container. Use your supported subscriptions through Anthropic, OpenAI-compatible and Gemini APIs while keeping provider logins and configuration in your own R2 bucket.

The gateway uses Cloudflare's native Container API. Its normal idle timeout is **one second after the Durable Object becomes inactive**, replacing the previous 30-minute helper timeout. Active responses and WebSockets are forwarded as platform streams. Pending provider sign-ins and background persistence receive bounded activity holds. No polling alarm or permanent monitor keeps an unused container awake.

## Architecture

| Component | Runtime | Responsibility |
|---|---|---|
| Public gateway | Rust compiled to Wasm in Workers | Route policy, dashboard login, HMAC sessions and access decisions |
| Cloudflare adapter | Small TypeScript platform layer | Bindings, streaming I/O and native container lifecycle |
| Provider engine | Upstream Go CPA in a Linux container | Provider logins, token refresh, model protocols, translation, usage and quotas; a small lifecycle patch reports active background work |
| Durable state | Existing R2 bucket | Configuration and OAuth credentials across sleep and deployment |

The public Worker answers liveness, login, logout and unknown routes without contacting the container's Durable Object. Requests requiring CPA keep the original singleton identity. Native container startup is coordinated, readiness is checked before forwarding, and inference requests are never replayed on startup errors.

This rewrite preserves the existing Worker name `sub2api`, `Cpa` class, `CPA` binding, `cf-singleton-container` object, `v1` migration and `STATE` bucket binding. It needs **no provider-data migration**. The existing Durable Object also stores temporary activity deadlines so an object restart cannot shorten an ongoing sign-in. It retains the existing container scheduling policy because switching that policy requires a separate application and namespace migration.

Provider execution remains in CPA. Bypassing it merely because a model has an API key can change subscription priority, usage accounting or TLS behavior. The separate Workers-only alternative remains available below with its existing limitations.

See [architecture and migration decisions](docs/architecture.md) and [performance measurements](docs/performance.md).

## Build and verify

Requirements: Node.js 22 or newer, the Rust toolchain declared in `rust-toolchain.toml`, `wasm32-unknown-unknown`, and **wasm-bindgen-cli 0.2.130**. Docker is needed for the provider image smoke test and image deployment.

```bash
npm ci
rustup toolchain install 1.99.1 --profile minimal --target wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
npm run verify
npm run test:runtime
sh test/container-smoke.sh
```

`npm run verify` builds the locked Rust crate, runs Rust unit tests, typechecks the platform adapters and existing Workers-only alternative, lints, and runs the JavaScript/TypeScript tests against the actual compiled Wasm. `test:runtime` additionally runs the gateway in workerd and checks login, idle-safe liveness, uploads, streaming and WebSocket upgrades with a controlled provider.

The workerd smoke test does not prove Cloudflare has stopped a production container or that a real provider account can connect. Those checks require the Docker image test and a configured live installation.

## Continuous deployment

The main install requires a Cloudflare account with Containers enabled and the appropriate Workers plan. See [Containers availability and limits](https://developers.cloudflare.com/containers/platform-details/limits/) and [pricing](https://developers.cloudflare.com/containers/pricing/) for current requirements.

1. Enable GitHub Actions in this fork.
2. Add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the intended account. The token needs the permissions required to deploy Workers, Containers/registry images and the R2 bucket.
3. For a **new installation**, also add `SUB2API_DASHBOARD_PASSWORD` and `SUB2API_MANAGEMENT_KEY`. Use different random strings, each at least 32 characters of `A-Z a-z 0-9 _ -`; `openssl rand -hex 32` generates a suitable value. These runtime secrets are supplied only to deployment, never to builds or uploaded artifacts.
4. Run **deploy container** manually once. It runs the verification pipeline, then installs the Rust gateway and tested provider image.
5. Open your `sub2api.<account-subdomain>.workers.dev` URL, sign in and add an API key in the dashboard.

After installation, each successful `ci` run for the current `main` revision deploys that same tested revision. A weekly run checks and rebuilds the upstream provider image through the same pipeline. Both install variants share a production deployment lock and refuse to overwrite the other variant. A new install is manual; normal pushes do not choose a different architecture for you.

CI builds and smoke-tests the provider image **once**, saves it with checksums, and deploys its immutable Cloudflare registry digest. It also packages the verified Worker/Wasm modules once. Deployment rejects altered artifacts, dirty source provenance and obsolete commits instead of silently rebuilding something different. No Cloudflare credentials are passed to package installation or the upstream image build. The small provider lifecycle patch checks the expected upstream source structure; an incompatible upstream update fails the build and leaves the existing deployment in place.

Set optional `SUB2API_CONTAINER_TEST_KEY` (or `SUB2API_TEST_KEY`) to an existing gateway API key for an authenticated post-deployment model-list check. Without it, authentication testing is explicitly reported as skipped; public liveness and provider readiness still have to pass.

Existing installations keep their Cloudflare secrets when the optional runtime secrets above are absent. CPA reads `MANAGEMENT_KEY` only when first creating its config; change an existing CPA management key through its dashboard. Do not use the legacy **move to container** workflow for this in-place Rust update.

### Manual deployment

```bash
npm ci
npm run verify
npx wrangler login
npx wrangler r2 bucket create sub2api # only for a new bucket
npx wrangler deploy
sh scripts/set-secrets.sh
```

Install the pinned Rust/Wasm tools first. Wrangler's custom build runs `npm run build`. The secret helper prints newly generated secrets once; keep them privately. For an existing install, retain its current secrets and R2 state. Manual Wrangler deployment builds an image locally; GitHub Actions is the path that carries the exact smoke-tested image to production.

## Idle behavior and health checks

`CONTAINER_IDLE_TIMEOUT_MS` is set to `"1000"` in `wrangler.jsonc`. Valid values are whole milliseconds from `1` to `21600000`. One millisecond is the smallest accepted setting; one second is the practical default to avoid immediate teardown between closely spaced requests. A shorter timeout reduces idle running time and increases the chance that the next request needs a cold start. It cannot make cold starts disappear.

CPA has work that continues after an HTTP reply, so the effective timeout also accounts for that work:

| Situation | Temporary protection |
|---|---|
| Normal idle period after a model request | Configured timeout, one second by default |
| Pending provider sign-in | Provider expiry plus a 60-second completion buffer; six minutes for a known callback flow without an expiry, up to 31 minutes for device, plugin or unidentified flows |
| Successful settings or credential mutation | A 35-second grace period while asynchronous persistence starts and finishes |
| Actual background refresh, reload or R2 persistence | An internal 90-second lease, renewed only while the task exists and released when it ends; a task cannot renew past its fixed 15-minute ceiling |

OAuth status polling does not extend the original sign-in deadline. Completion or an accepted cancellation removes that flow's hold and reserves the persistence grace period. Separate concurrent flows remain protected. Background jobs obtain their hold before starting provider work; a failed grant prevents the work from starting. Native inactivity settings are recalculated from absolute deadlines, and stale background jobs are cleared when a stopped container starts fresh.

The 35-second grace is an allowance for deferred writes, not an assertion that every remote operation finishes within that time. Actual background work has its own activity reporting. Platform failure, a forced stop or an operation exceeding its bounded lifetime can still interrupt it.

During an in-place rollout, Cloudflare may activate the new Worker before replacing the old provider image. An image without the activity protocol keeps the previous 30-minute timeout until the patched image is detected. The one-second setting is enabled only after that capability check; detection happens on real requests, with no idle polling loop.

| Endpoint | Meaning | Wakes the provider container? |
|---|---|---|
| `GET /healthz` | Public gateway is responsive | No |
| `GET /readyz` | CPA is ready to accept requests | Yes, if asleep |

Use `/healthz` for frequent availability checks. Polling `/readyz` keeps exercising CPA and undermines idle savings. The timeout begins when the Durable Object becomes inactive, not at a fixed interval after the last HTTP request. Deployment and platform failures can still interrupt active connections.

## Connect a subscription

1. Open **OAuth login** in the dashboard and choose the provider.
2. Complete the provider's sign-in.
3. If the provider redirects to an unavailable localhost page, paste that URL into the dashboard's **Callback URL** field, or replace its localhost origin with your gateway origin and open it in the same signed-in browser.

CPA persists the login in R2 and handles refreshes. Use only subscriptions and provider access you are authorized to use.

## Use the gateway

Anthropic-compatible clients:

```bash
export ANTHROPIC_BASE_URL=https://sub2api.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=<your-gateway-api-key>
```

OpenAI-compatible clients:

```bash
export OPENAI_BASE_URL=https://sub2api.<your-subdomain>.workers.dev/v1
export OPENAI_API_KEY=<your-gateway-api-key>
```

Gemini clients use `<gateway>/v1beta` with the same gateway key. `GET /v1/models` lists the models available to the configured providers. Give each client its own gateway key so it can be revoked independently.

## Workers-only install (beta)

**Beta.** The Rust gateway with its CPA container is the main install. This one is still in progress and may change between releases.

For Workers Free. No container: the Worker runs our TypeScript port of CPA, with the same dashboard. API keys work with every app and provider. Logins are limited: Claude login works only with Claude Code, and ChatGPT login only for voice over WebSocket.

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/agentbeau/sub2api/tree/main/worker"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" width="170"></a>

See [worker/README.md](worker/README.md) for setup.

One Durable Object keeps logins, config, usage and logs:

```
app ──► Worker: CPA port ──► Claude / Codex / Gemini / Vertex / Kimi / xAI / OpenAI-compatible
        · API key check         · any app format to any provider
        · dashboard sign-in     · routing, failover, cooldowns
          │
          └─► Durable Object (SQLite): logins, config, usage, logs
```

### Limits

If you need anything marked **No**, use the Container install.

| Feature | Container | Workers&#8209;only |
|---|---|---|
| ChatGPT (Codex) login: text and code | Yes | **No**: chatgpt.com blocks Workers with HTTP 403 (use a Codex API key) |
| ChatGPT login: voice | WebSocket and WebRTC | WebSocket only (WebRTC gets the same 403) |
| ChatGPT login: quota in the dashboard | Yes | **No** |
| Claude login | Any app | Claude Code only (Anthropic answers other apps with HTTP 429; use a Claude API key) |
| Logins | Every CPA provider | Claude, ChatGPT, Kimi, and Vertex service accounts |
| Images, video, speech (`/v1/images`, `/v1/videos`, `/v1/audio/speech`) | Yes | **No** |
| Responses WebSocket, `/v1/responses/compact`, legacy `/v1/completions` | Yes | **No** |
| Realtime client secrets, sideband, SIP, translations | Yes | **No** |
| Request logs | Full detail | Last 2,000 lines, no request detail |
| Gemini safety filters | Off, as in CPA | Google's defaults |

Workers Free also caps every account ([Workers](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Past a cap, calls fail until 00:00 UTC:

- **100,000 requests a day**, for the Worker and for its Durable Object. Each API call uses both.
- **10 ms of CPU per request.** Claude Code and Codex CLI calls use under 1 ms, but a very long conversation translated between formats can run out and fail.
- **50 outgoing requests per request**, so a call tries at most 10 logins or keys before it gives up.
- **5 GB of storage** in total.

Moving to Workers Paid? `sh scripts/move-to-container.sh`, or the **move to container** workflow, copies your logins, API keys and config into the Container install's R2 bucket and keeps a backup there. Add `--replace` (the workflow's `replace` step) to then swap the Worker for the Container install.

## Upstream and license

This fork builds on [PlaygrndLabs/sub2api](https://github.com/PlaygrndLabs/sub2api) and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It is not affiliated with the model providers or Cloudflare. [MIT](LICENSE).
