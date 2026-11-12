# Public endpoint and neutral interface

The production endpoint is `https://api.agentbeau.dev`. The dashboard is at
`/login`, OpenAI-compatible clients use `/v1`, and Gemini clients use `/v1beta`.
The custom domain is declared in `wrangler.jsonc` so checked future deployments
retain it. It is a native Workers Custom Domain, not a redirect through a tunnel.
The workers.dev address remains available for deployment health checks and
recovery; clients should use the custom domain.

## Presentation policy

The public interface is neutral rather than rebranded. Login and message pages
use `Console`, and the edge dashboard uses `Provider controls`. The compiled
provider panel removes product logo elements and artwork, the product favicon,
project repository link elements, product names in display text and translations,
and product-prefixed browser storage keys. It does not substitute another logo
or product name. Panel header readers and public response metadata use the
neutral `X-Engine-*` names together.

Panel processing happens during the checked build, not for every page request.
The HTML is extracted from the exact smoke-tested image and published to R2 by
the existing artifact pipeline. Source changes that invalidate the expected
logo or header-reader structure stop the build rather than ship a partial edit.

Provider names identify real services and models; plugin publisher identities
identify who supplied executable code. Those factual identities, native provider
protocol values and required third-party license notices are preserved. They
are not presented as the application's product brand. Provider API response
bodies are not rewritten or buffered for presentation changes.

## Compatibility and access

The Worker name, container application, `Cpa` class, `CPA` binding, migration,
singleton, existing R2 bucket and session signing format remain unchanged. These
are infrastructure identities, not frontend labels. Renaming them solely for
appearance could detach saved state or disrupt rolling deployments.

The domain change does not rotate the dashboard password, management key or
client API keys. Browser cookies and local storage are origin-scoped, so sign in
again at the new hostname using the existing password. The panel may ask for
the existing management key again. OAuth return URLs should use the new origin;
relative links and same-origin controls already follow it.

Dashboard viewing, status checks and locally rejected requests must remain
non-waking. Accepted API requests and explicit controls keep native automatic
startup, active-stream handling, temporary work holds and the existing
one-second normal idle timeout. This change does not promise that a valid
request which later fails at its upstream provider can be rejected before wake.

Reference: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
