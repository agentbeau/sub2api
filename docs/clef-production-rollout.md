# Production Clef classifier rollout

Production `Cpa` and the isolated preview now use the same authenticated inference preparation hook. The root Wrangler config declares the direct Workers AI binding and leaves `CLEF_ENABLED=false`; no production classifier calls occur until an operator enables that flag in a reviewed, versioned rollout. Do not route these calls through AI Gateway or add conversation history, tools, credentials, provider responses, or request headers to the classifier input.

The worker admits only JSON chat-completions and Responses requests for the four explicit model IDs in `src/inference-classifier.ts`. It reads at most 64 KiB of body, extracts at most 2,048 characters from the last user text, does not truncate, bypasses explicit effort, reserves one DO-storage budget unit, and fails open on timeout or classifier failure. Per DO, the durable budget allows at most 100 reservations/day and 10/minute; concurrent classifier calls are capped at two. The AI call has a 600 ms response wait, but its promise is kept alive with `waitUntil` and may continue after the caller is forwarded.

Cloudflare currently lists Clef-flash at $0.038 per million input tokens, or 3,455 neurons per million input tokens. The reservation cap is a call-count limit, not a hard dollar cap: observed token usage should be reviewed in Workers AI billing/usage before enabling the flag. The classifier input limit and no-history rule bound transmitted content; callers may still incur charges for calls that time out, fail open, or lose the decision race. See [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) and [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/).

## Release gates

1. Build the exact source and verify the Worker bundle plus Workers AI binding metadata.
2. Deploy with `CLEF_ENABLED=false`, verify the running Worker revision and unchanged container image/configuration.
3. Run authenticated synthetic-provider checks for explicit-effort bypass, inferred effort, classifier failure/timeout, concurrency/budget caps, and unchanged streaming/cancellation behavior.
4. Enable the flag only after those checks pass; observe actual Clef calls, Workers AI usage, and error rates before widening traffic.

This change does not enable Clef in production in this branch. Production remains on its currently verified version until the authenticated rollout gates can be completed.
