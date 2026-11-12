# Dashboard sign-in

This installation uses Cloudflare Access with the existing Cloudflare identity provider for the initial dashboard login. Visit `https://api.agentbeau.dev/management.html`. Access is restricted to the configured owner and requires membership of the hosting Cloudflare account. The old dashboard password is not an alternative login when `DASHBOARD_AUTH=cloudflare`.

The native console's management key, client API keys, provider accounts, state bindings and container lifecycle remain unchanged. The former timed controls wrapper is not restored. Authentication and reading the static console do not start the provider; native administration and admitted model requests keep their existing on-demand behavior.

## Trust boundary

The public Worker checks the platform-owned `ctx.access.aud` against `ACCESS_AUD`. It does not trust an email header, a caller-supplied JWT string, or an old dashboard session cookie. The verified decision is carried to the existing Durable Object over the private `fetchWithAccess` RPC. Ordinary HTTP `fetch` calls into the object do not inherit that decision. Cloudflare credentials and browser cookies are removed before provider forwarding. Browser writes from a different origin are rejected.

The policy and app are Cloudflare resources, not additional application passwords. Their non-secret deployment record is `ops/dashboard-access.json`. The audience is also retained in `wrangler.jsonc` so continuous deployment does not revert the login mode. No development Access identity is included in production configuration.

## API compatibility

Both the custom hostname and the existing workers.dev hostname use hostname-based Access. Only the model API paths and the existing health/readiness paths are public Access overrides. Model requests still require their original client API key; a Cloudflare login does not authorize model access. There is no Worker-wide Access application, avoiding its documented WebSocket limitation. Uncovered alternate hostnames cannot use password cookies to reach browser routes because the Worker still requires the matching platform Access context.

`/login` redirects authenticated visitors to the console rather than serving a password form. `/logout` clears the legacy cookie and redirects to Cloudflare's `/cdn-cgi/access/logout` endpoint. The native provider-panel sign-out remains separate from signing out of Cloudflare.

## Operations and rollback

Do not rotate provider credentials for this change. The unused dashboard password secret is retained for rollback, not accepted in Access mode. A rollback must restore the previous Worker and Access app configuration together; never remove Access while leaving protected routes without an authentication mode. Changes to the reusable owner policy are managed separately and must not broaden access unintentionally.

Validation includes rejected forged headers/legacy cookies, matched and unmatched native audiences, private RPC propagation, unchanged model authentication, response streams and callback handling. A real owner login may require the owner's Cloudflare MFA; do not treat a simulated test identity as a completed production login.

References:
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
