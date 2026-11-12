# Security

## Reporting a vulnerability

Please report privately through [GitHub's private vulnerability reporting](https://github.com/agentbeau/sub2api/security/advisories/new), when enabled. Don't publish secrets in an issue. Bugs in the original gateway should also be reported to its upstream maintainer.

Bugs in CPA itself belong upstream at [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## Security model

Everything a deploy holds belongs to its owner: your Cloudflare account, your R2 bucket and your secrets. This repository has no keys, telemetry or shared backend.

- **API access is checked before startup.** With ordinary client keys, `src/key-guard.ts` reads the authoritative R2 configuration for each request and matches CPA's credential-header and query rules. Missing keys, invalid keys, empty key lists and malformed configuration never start CPA. There is no random-key probe. A bounded fallback during an asynchronous settings save may validate a changed key only in an already-running provider. Enabled authentication plugins retain native startup because their effective authentication rules can be known only after loading the plugin; CPA remains authoritative for those credentials.
- **The dashboard needs two secrets.** First the `DASHBOARD_PASSWORD` sign-in, which sets an HMAC-signed `__Host-` cookie (HttpOnly, Secure, SameSite=Strict) that lasts 12 hours. Then CPA's own management key. Sign-in attempts are limited to 5 a minute per IP. Changing the password signs out every session.
- **Only known paths reach CPA.** Supported API requests and explicit `/readyz` checks can start the provider. Dashboard HTML comes from the edge. Signed-in management requests and OAuth callbacks use only an already-running process. Explicit control starts require both the dashboard session and a same-origin POST. `/healthz` is local liveness. Unknown paths and encoded separators return 404. Browser cookies are stripped before provider forwarding. Rust implements the route and session policies; platform streams are not copied into Wasm memory.
- **Dashboard viewing does not start the provider.** The control shell cannot be framed; the exact upstream panel can be framed only by this origin. Its bytes come from the smoke-tested image and are checksummed in the deployment artifact. An explicit start grants two minutes of editing time, and polling does not extend that deadline. Closing controls releases only that hold. Provider errors after an admitted request and plugin authentication decisions can still require a running container.
- **State stays in your R2 bucket.** CPA's S3 client talks to `http://r2.internal`, which only the container can reach and which the Worker serves from an R2 binding. No R2 API tokens exist.
- **Native container lifecycle preserves transport.** The R2 bridge validates its internal host and HTTP scheme. Provider HTTPS is not intercepted, so it keeps CPA's own Linux transport. Concurrent cold requests share readiness work; model requests are sent once. Native request activity protects streams, and bounded leases protect pending sign-ins and background work. The internal activity endpoint accepts only a small validated protocol, reaches the existing singleton, and cannot start a stopped provider container.
- **Verified deployment inputs.** GitHub Actions packages the gateway and provider image before deployment and verifies their revision and checksums. Production references the pushed image by digest. Runtime secrets are not stored in those artifacts, and build steps do not receive Cloudflare deployment credentials.
- **An upstream you trust.** By default the container builds the newest CPA release tag, and both installs download the newest dashboard release, so a new upstream release reaches your gateway on its next deploy, including the weekly one. The dashboard runs on your gateway's origin and holds your management key, so a compromised upstream release would control your gateway. To freeze the CI inputs, set the `CPA_VERSION`, `PANEL_VERSION` and `PANEL_SHA256` repository variables. Manual container builds can use the corresponding build arguments in `container/Dockerfile`. The build fails when a supplied dashboard checksum does not match. Each build prints the CPA tag and the dashboard's SHA-256.

### The Workers-only install, beta (`worker/`)

- **API calls need a key from `access.api-keys`.** The key check and the Claude token are cached per Worker isolate for at most a minute, so a key or login you remove stops working everywhere within a minute.
- **The dashboard and management API need two secrets,** as above: the `DASHBOARD_PASSWORD` sign-in cookie and the management key (`MANAGEMENT_KEY`). Both installs require a separate `MANAGEMENT_KEY`, because the dashboard can remember the key it is given in browser storage; the Workers-only install keeps its management API off until the key is set and differs from the password. Sign-in attempts are limited to 5 a minute per IP, and the dashboard page is never framed.
- **Provider handling is separate.** The Workers-only implementation has its own provider adapters and credential storage in the `Store` Durable Object. Its provider support and restrictions are documented in `worker/README.md`; the Rust rewrite does not replace those adapters.

## Your part

- Use long random secrets: `openssl rand -hex 32`.
- Give each app its own API key, and delete a key the moment it may have leaked.
- Never commit `.dev.vars`. It is in `.gitignore`.
