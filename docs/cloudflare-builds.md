# Continuous deployment with Cloudflare Workers Builds

Workers Builds can deploy the existing container installation directly from
`agentbeau/sub2api` without storing a Cloudflare token in GitHub Actions secrets.
Keep GitHub CI enabled: it checks pull requests before they reach `main`.
Choose one automatic production deployer; do not also enable the GitHub deploy
workflows by adding their Cloudflare secrets while Workers Builds is active.

This path updates the existing `sub2api` Worker and container application. It
refuses a first installation or the Workers-only alternative, and preserves
the existing dashboard password, management key, Durable Object identity and
R2 state. It does not create tokens or rewrite runtime credentials.

## Build configuration

Connect the existing Worker to the repository's `main` branch, select the
existing appropriate **build token**, and disable previews. Use these settings:

| Setting | Value |
| --- | --- |
| Root directory | `/` |
| Production branch | `main` |
| Build command | `node scripts/cloudflare-builds.mjs build` |
| Deploy command | `node scripts/cloudflare-builds.mjs deploy` |
| Previews | Disabled |
| Build caching | Disabled for the initial verified setup |
| `NODE_VERSION` | `24.22.1` |
| `SKIP_DEPENDENCY_INSTALL` | `1` |
| `CLOUDFLARE_ACCOUNT_ID` | The existing account ID; a non-secret build variable |

`SKIP_DEPENDENCY_INSTALL=1` is required. Cloudflare otherwise installs
dependencies before our entrypoint can sanitize the child environment. The
wrapper runs `npm ci` itself after applying that allowlist. Do not add dashboard
passwords, management keys, provider credentials or gateway client keys to the
build environment. Optional `CPA_VERSION`, `PANEL_VERSION` and `PANEL_SHA256`
build variables pin the same upstream inputs supported by GitHub CI.

Cloudflare supplies `WORKERS_CI`, `WORKERS_CI_BUILD_UUID`,
`WORKERS_CI_COMMIT_SHA` and `WORKERS_CI_BRANCH`. Do not override them. The wrapper
requires a complete build identity, the `main` branch and a clean checkout that
matches the supplied commit. It also checks the current public GitHub `main`
ref before building and before entering the prepared deploy. The wrapper sets
`SUB2API_EXPECTED_MAIN_SHA` to that verified revision; operators do not need to
configure this variable. `deploy-prepared.mjs` uses the same public-main check
after pushing the image, immediately before uploading the R2 panel, and again
immediately before invoking Wrangler to activate the Worker. A changed main or
failed lookup stops that phase. These Git reads receive no deployment token and
require no additional Cloudflare API permissions.

The checks narrow the interval in which an older build could deploy, but are
not an atomic lock. Cloudflare documents skipping
[superseded queued builds](https://developers.cloudflare.com/changelog/post/2026-07-24-skip-superseded-builds/),
not cancellation or activation ordering for already-running builds. Main can
still change after a successful check. The panel upload and Worker/container
deployment are also separate writes: if main changes after the panel upload,
the final check stops Worker activation but the uploaded panel remains. Keep
one automatic production deployer and do not describe these checks as providing
GitHub's production concurrency lock.

The [Workers Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)
can configure this through `POST /accounts/{account_id}/builds/workers` using the
existing Worker's immutable `script_tag`, the GitHub owner/repository IDs,
`production_settings`, the selected `build_token_uuid`, and
`previews_enabled: false`. The API schema also requires
`previews_base_config`; use the same build command and token with
`node scripts/cloudflare-builds.mjs validate` as its non-deploying command.
Previews remain disabled, and the wrapper rejects a non-`main` branch.

## What runs before production changes

The build installs Rust **1.99.1** with `wasm32-unknown-unknown` and
wasm-bindgen **0.2.130**, matching GitHub CI. The rustup bootstrap is pinned to
**1.28.2** and its official SHA-256; the wasm-bindgen archive uses the same pinned
SHA-256 as GitHub. A changed download fails before execution.

The wrapper then runs the existing application/Rust/type/lint checks,
deployment safeguards, packaged workerd tests and complete container smoke.
It packages the Worker, builds the provider image once, and copies the branded
panel out of that exact tested image. Cloudflare's Docker environment uses host
networking; the smoke runs the same assertions against ports 8317 and 9000.
GitHub CI also exercises this host-network mode against its already-built image
before publishing the artifact. No image is rebuilt for deployment.

Successful checks create a receipt under the ignored `.wrangler` build output.
It records the build UUID, source revision, target account and hashes of both
artifact manifests. A repeated build removes the old receipt before any gate.
The deploy phase checks that receipt, every artifact checksum, the clean
checkout, the existing installation and current `main` before calling
`deploy-prepared.mjs`. This preserves the existing image-by-digest deployment
and exact-panel upload to R2 before Worker activation.

After deployment, `check-deployed.mjs` checks liveness, explicit native provider
readiness and anonymous API rejection. It does not receive the deployment token
or runtime credentials. Authenticated model generation remains a separate test
requiring a connected provider account; these checks do not claim it works.

## Credentials and first-run verification

Cloudflare documents a selected build token for deployment, but does not promise
that it is absent during the build command or automatic dependency installation.
The entrypoint therefore treats it as potentially present throughout the run.
It reports only whether the deployment token was present in the build phase.

An explicit environment allowlist excludes deployment tokens, runtime secrets,
GitHub/npm tokens and unrecognized variables from npm, tool installation,
compilation, packaging and container smoke children. It keeps the platform's
proxy and CA trust settings. Wrangler's live Worker identity guards are removed
from token-free dry runs and restored only for deployment. Environment filtering
prevents credential inheritance; it is not a security sandbox for malicious
code with access to the same build host. Run this pipeline only for trusted
code merged to `main`.

After GitHub CI passes, run one controlled build with the real deploy command
to verify that the selected token can publish the image, upload the panel,
update the Worker and roll out the container. The same build executes all
verification gates before any production writes. Confirm the build succeeds
and the active Worker and container image match its checked revision. A token
listed in Cloudflare is not proof of its validity or permissions. If a step is
denied, report that specific permission failure; do not silently create or
broaden a token.

For an optional run that must perform no production writes, temporarily set
the deploy command to `node scripts/cloudflare-builds.mjs validate`. It runs all
build gates and verifies the receipt and artifacts, then stops. This can prove
the build environment and Docker smoke work, but cannot prove token write
scopes; it is not required before the controlled deployment above.

References: [build environment and dependency install](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/),
[build variables and token configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
and [container deployment in Workers Builds](https://developers.cloudflare.com/containers/guides/deploy/).
