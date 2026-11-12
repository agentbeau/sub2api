# Continuous deployment with Cloudflare Workers Builds

Workers Builds deploys the existing container installation using the exact
Worker and provider image artifacts that passed GitHub CI for its source commit.
GitHub publishes those original ZIP archives as public Release assets; Cloudflare
downloads and verifies them without a GitHub token. The existing Cloudflare build
token remains in Cloudflare, with no GitHub deployment secrets to configure.
Keep GitHub CI enabled: it checks pull requests and the final `main` commit.
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
build environment. Set optional `CPA_VERSION`, `PANEL_VERSION` and `PANEL_SHA256`
inputs as GitHub repository variables for CI; the Cloudflare consumer does not
rebuild upstream inputs or override the tested image.

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

## Where testing and publication happen

GitHub CI retains the pinned Rust **1.99.1**, wasm-bindgen **0.2.130** and
wasm-bindgen download checksum. It compiles and verifies the gateway, runs the
source workerd streaming/WebSocket suite and prepared-bundle public/RPC checks,
builds the provider image once, and exercises the
full Docker smoke against that exact image. The host-network smoke also runs
against the same image without rebuilding. CI extracts the branded panel from
that checked image and publishes its existing checksummed Worker/image artifacts.

The separate `publish tested artifacts` workflow starts only after a successful
`ci` workflow run. Its initial read-only job verifies the GitHub API's repository
and head-repository identity, `push` event, `main` branch, exact `ci.yml` workflow
ID/path, completed successful result, full SHA and current main. Only then can a
job with `contents: write` and `actions: read` check out that exact revision. This
job installs no dependencies and receives only GitHub's automatic job token.

The publisher downloads the original `container-worker` and `container-image`
Actions ZIPs and verifies their original sizes and SHA-256 digests. It does not
unpack, rebuild or repack them. It creates a draft prerelease with a tag shaped
as `sub2api-ci-<full-SHA>-<CI-run-ID>-<attempt>`, uploads those two ZIPs and
`receipt.json`, verifies the complete asset set, then publishes the release with
`make_latest: false`. Incomplete drafts remain invisible to the anonymous
Cloudflare consumer. Publication never replaces an existing asset or published
release; a matching completed publication is a read-only success. These are
application checks, not a claim that GitHub Release assets are platform-immutable.

Only build outputs and source metadata are published. Runtime passwords,
management keys, provider credentials and gateway client keys are neither build
inputs nor archive contents. The publisher's token is kept out of the build and
smoke jobs; signed artifact-storage redirects receive no authorization header.

## What Cloudflare verifies before deployment

The Cloudflare build command runs `npm ci` with a sanitized environment, verifies
the deployment helpers, and waits for its exact commit's trusted CI run and
published release. Waiting is bounded to **12 minutes**, with **30-second** polls
of one endpoint at a time, leaving room under Workers Builds' 20-minute limit
and avoiding an excessive anonymous GitHub API request rate.

The consumer requires a successful main-push run from the actual `ci.yml`
workflow and a release tag resolving to the same commit. For each ZIP it checks
both the Release asset digest and the independent original Actions artifact
ID/digest, source-run identity, and byte count. A receipt cannot override those
public GitHub facts. It refuses wrong repositories, PR runs, mixed source IDs,
changed attempts, incomplete releases, modified payloads and missing provenance.
It never chooses a generic latest release.

The verified ZIPs are extracted into new directories with checks against path
traversal, symbolic links, duplicates and excessive file counts or sizes. The
existing clean-source, payload manifest and image-ID validators still run. The
prepared Worker's public routing and Cpa/R2Bridge RPC are exercised in workerd
again using only its exported bundle and Wasm. Source streaming/WebSocket tests
remain a required GitHub CI gate; artifact mode does not import ignored Rust
build output. Cloudflare does not compile Rust,
rebuild the image, start a smoke container or extract the panel from a new image.

Successful checks create a local receipt under ignored `.wrangler` output. It
records the Cloudflare build UUID/account, source SHA, original GitHub run and
artifact identities, and hashes of both artifact manifests. A repeated build
removes any earlier success before doing work. The deploy phase rechecks this
receipt, payload checksums, current source-run attempt and original Actions
metadata before using `deploy-prepared.mjs`. It loads and pushes the exact tested
image, uploads its checked panel to R2, and activates the prepared Worker.

After deployment, `check-deployed.mjs` checks liveness, explicit native provider
readiness and anonymous API rejection. It receives no deployment token or
runtime credentials. Authenticated model generation remains a separate test
requiring a connected provider account.

### Why Docker smoke stays in GitHub CI

The first controlled Workers Builds run successfully built the image, but its
first `docker run` failed in the managed Docker daemon before the smoke helper
could start:

```text
open /sys/fs/cgroup/user.slice/user-2500.slice/cgroup.controllers: no such file or directory
```

No deployment phase ran. The error matches Docker's rootless/systemd controller
lookup, which is separate from a container's `--cgroup-parent` selection. The
pipeline preserves the full real-image smoke in GitHub and transfers its exact
passed bytes; it does not change the builder's cgroups, daemon, privileges or
verification gates. Cloudflare documents Dockerfile builds and pushing prebuilt
images; its current build environment did not pass this container-start test.

### Retention, retries and interrupted publication

GitHub Actions can retain older same-name artifacts during reruns. CI uses
`overwrite: true` for its existing artifact names so fresh uploads receive new
immutable Actions IDs. The publisher still refuses missing or ambiguous names,
and both sides recheck the selected source run and attempt. Published Release
assets remain unchanged.

An Actions artifact marked `expired: true` can still prove a published ZIP's
integrity if its public immutable ID, original digest and source metadata remain
available. If GitHub removes that metadata, this pipeline fails closed. A full
CI rerun can replace those original records and also invalidate an older
release's provenance. **Rerun all CI jobs, wait for the new run-specific artifact
release, then retry the Cloudflare build.** This selects a new run/attempt tag
without replacing the old release. Current-main and clean-source guards still
apply.

A draft retry can reuse already uploaded, matching assets. A failed GitHub upload
can leave a `starter` or mismatched asset; the publisher refuses to replace it.
Use a full CI rerun and its new publication identity instead of modifying a
published release. Missing metadata, a CI failure, a timeout or a checksum error
cannot produce a successful Cloudflare receipt.

## Credentials and first-run verification

Cloudflare documents a selected build token for deployment, but does not promise
that it is absent during the build command or automatic dependency installation.
The entrypoint therefore treats it as potentially present throughout the run.
It reports only whether the deployment token was present in the build phase.

An explicit environment allowlist excludes deployment tokens, runtime secrets,
GitHub/npm tokens and unrecognized variables from npm, archive extraction,
helper tests and packaged workerd children. It keeps the platform's
proxy and CA trust settings. Wrangler's live Worker identity guards are removed
from token-free checks and restored only for deployment. Environment filtering
prevents credential inheritance; it is not a security sandbox for malicious
code with access to the same build host. Run this pipeline only for trusted
code merged to `main`.

After the trusted CI run and artifact publication pass, run one controlled
Cloudflare build with the real deploy command. This must verify that the
managed Docker daemon can load and push the pretested image, and that the selected
token can upload the panel, update the Worker and roll out the container. The
consumer performs its provenance and runtime gates before production writes.
Confirm the build succeeds and the active Worker and container image match its checked revision. A token
listed in Cloudflare is not proof of its validity or permissions. If a step is
denied, report that specific permission failure; do not silently create or
broaden a token.

For an optional run that must perform no production writes, temporarily set
the deploy command to `node scripts/cloudflare-builds.mjs validate`. It runs all
build gates and verifies the receipt and artifacts, then stops. This can prove
the artifact handoff and packaged runtime checks work, but cannot prove image
load/push or token write scopes; it is not required before the controlled
deployment above.

References: [build environment and dependency install](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/),
[build variables and token configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
[container deployment in Workers Builds](https://developers.cloudflare.com/containers/guides/deploy/),
[prebuilt image management](https://developers.cloudflare.com/containers/guides/image-management/),
[original Actions artifact metadata/downloads](https://docs.github.com/en/rest/actions/artifacts),
[public Release assets](https://docs.github.com/en/rest/releases/assets),
[automatic GitHub job token](https://docs.github.com/en/actions/concepts/security/github_token),
[artifact overwrite semantics](https://github.com/actions/upload-artifact/blob/main/docs/MIGRATION.md),
and [Docker rootless controller lookup](https://github.com/moby/moby/blob/master/daemon/oci_linux.go).
