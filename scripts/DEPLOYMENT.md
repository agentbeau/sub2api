# Verified provider image and dashboard

## Prepared deployments

`build-container-image.mjs` builds the provider image once and runs the container
smoke against that image. It then creates a stopped container from the immutable
image ID and copies `/panel/management.html` into the `container-image` artifact.
CPA is not started for extraction, and the image is not changed or rebuilt.

The artifact contains `image.tar.gz`, `management.html`, and `manifest.json`.
The manifest records the source revision, clean-source status, image identity,
and separate checksums for both payload files. A container deployment refuses an
artifact with a missing or changed dashboard, even if the image itself is valid.

`deploy-prepared.mjs` verifies the complete artifact before account mutations,
loads and pushes the tested image, and uploads the verified HTML to
`sub2api/dashboard/management.html` using `wrangler r2 object put --remote`.
The object uses `text/html; charset=utf-8` and `Cache-Control: no-cache`. The Worker
is deployed only after that upload succeeds. This keeps the public dashboard
available from the existing `STATE` bucket without starting the provider.

The upload replaces only `dashboard/management.html`. It does not change the
container image digest, provider configuration, stored credentials, or the
Workers-only installation. A failed panel upload stops the Worker deployment.

For a connector deployment of an older, already tested artifact without the
separate HTML file, extract the panel from that artifact's verified OCI layers.
Verify the original archive and image digests, apply layer order and whiteouts,
and upload the resulting `/panel/management.html` bytes to the same object key.
Do not download a newer panel or rebuild the provider to obtain it.

For a manual production release, use the **deploy container** workflow on `main`.
The workflow carries the tested Worker modules, provider image and panel through
the same deployment checks. A local operator can use the same scripts from a
clean checkout with the pinned Rust/Wasm tools and Docker installed. Run the
build phase without Cloudflare or runtime credentials, and use fresh artifact
output directories:

```bash
npm ci
npm run verify
node scripts/prepare-deployment.mjs container
npm run test:runtime -- .wrangler/artifacts/container-worker/worker/index.js
node scripts/build-container-image.mjs
```

After that phase succeeds, provide `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` only to the deploy process. A new installation also needs
`SUB2API_DASHBOARD_PASSWORD` and `SUB2API_MANAGEMENT_KEY`, as described in the
README. Omit those two variables to preserve an existing installation's secrets.
Then run:

```bash
CHECKED_SHA="$(git rev-parse HEAD)" node scripts/deploy-prepared.mjs container \
  .wrangler/artifacts/container-worker .wrangler/artifacts/container-image
```

## Extract from an existing tested image

If an older artifact lacks the separate panel file, load its verified image
archive, confirm the immutable image ID against its manifest, and extract from
that ID. The following commands create a stopped extraction container; they do
not run CPA. Replace the placeholder with the verified image ID, not a mutable
tag:

```bash
set -eu
sub2api_image_id='sha256:<tested-image-id>'
mkdir -p .wrangler/panel-extract
sub2api_panel_container="$(docker container create --pull=never \
  --platform linux/amd64 --entrypoint /bin/true "$sub2api_image_id")"
trap 'docker container rm "$sub2api_panel_container" >/dev/null' EXIT
docker container cp "$sub2api_panel_container:/panel/management.html" \
  .wrangler/panel-extract/management.html
sha256sum .wrangler/panel-extract/management.html
```

Record that checksum and image identity before uploading. With the existing
bucket selected in the intended Cloudflare account:

```bash
npx wrangler r2 object put sub2api/dashboard/management.html \
  --file .wrangler/panel-extract/management.html \
  --content-type 'text/html; charset=utf-8' --cache-control no-cache --remote
```

This uploads only the static panel. Deploy the verified Worker modules as a
separate step. When the application image and configuration are unchanged, a
Worker-only deployment needs no container rollout; Wrangler supports
`--containers-rollout none` for that case. Preserve the existing application,
class, namespace, binding and scheduling policy.

## Cloudflare connector upload

The Cloudflare API supports a direct raw-body upload:

```text
PUT /accounts/{account_id}/r2/buckets/sub2api/objects/dashboard/management.html
Content-Type: text/html; charset=utf-8
Body: the verified management.html bytes
```

The object-key slash must remain literal, rather than `%2F`. The endpoint accepts
up to 300 MB. The Cloudflare connector's `cloudflare.request` accepts
`Uint8Array`, `ArrayBuffer` or `Blob` bodies without JSON encoding. Prefer the
verified bytes, check their SHA-256 and length before the request, and read the
object back to verify the same checksum after upload:

```js
await cloudflare.request({
  method: "PUT",
  path: `/accounts/${accountId}/r2/buckets/sub2api/objects/dashboard/management.html`,
  contentType: "text/html; charset=utf-8",
  body: verifiedPanelBytes,
});
```

A JavaScript HTML string is also sent as UTF-8 text when this non-JSON
`contentType` is specified. If using a string, verify the hash of
`new TextEncoder().encode(html)` first so decoding and re-encoding cannot change
the accepted file silently. The documented connector wrapper has no arbitrary
headers option, and the R2 upload endpoint does not document a `Cache-Control`
input. The edge response must supply the dashboard's no-cache policy; the
Wrangler upload above also stores that policy in the object metadata. Direct
connector upload does not require minting temporary S3 credentials.

For an existing Worker, read its current script settings and preserve non-secret
bindings and runtime settings when replacing modules through the multipart
Worker upload API. Set `keep_bindings: ["secret_text", "secret_key"]` to retain
existing secret values. Keep `CPA` pointing to the existing `Cpa` class and
namespace, `STATE` pointing to the existing bucket, and the container class
association. Omit migrations and declarative exports for this code-only update;
the existing `v1` migration has already been applied. Verify these identities and
the unchanged container image after deployment. No application create, delete,
policy change or rollout is needed when its effective configuration is unchanged.

The panel upload itself must not probe CPA. Dashboard viewing and rejected edge
requests remain separate from the dashboard's explicit provider connection and
shutdown controls; do not add a readiness probe to page load or panel provisioning.

API and behavior references: [R2 object upload](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/),
[Worker upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/),
and [container rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/).
