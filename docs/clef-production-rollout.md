# Production Clef classifier rollout

Production `Cpa` and the isolated preview now use the same authenticated inference preparation hook. The root Wrangler config declares the direct Workers AI binding and leaves `CLEF_ENABLED=false`; no production classifier calls occur until an operator enables that flag in a reviewed, versioned rollout. Do not route these calls through AI Gateway or add conversation history, tools, credentials, provider responses, or request headers to the classifier input.

The worker admits only JSON chat-completions and Responses requests for the four explicit model IDs in `src/inference-classifier.ts`. It reads at most 64 KiB of body, extracts at most 2,048 characters from the last user text, does not truncate, bypasses explicit effort, reserves one DO-storage budget unit, and fails open on timeout or classifier failure. Per DO, the durable budget allows at most 100 reservations/day and 10/minute; concurrent classifier calls are capped at two. The AI call has a 600 ms response wait, but its promise is kept alive with `waitUntil` and may continue after the caller is forwarded.

Cloudflare currently lists Clef-flash at $0.038 per million input tokens, or 3,455 neurons per million input tokens. As a planning example, 100 calls/day at 2,148 input tokens each (2,048 tokens of user text plus an assumed 100 tokens of fixed prompt) is about 742 neurons/day and $0.0082/day at list price before free allocation. This is an estimate, not a hard ceiling: the code limit is characters rather than tokens, tokenizer behavior varies, and timed-out or canceled-after-submit inference may still be billed. The model price is listed per input token; there is no separate output-token rate in the current pricing entry.

Workers AI provides 10,000 shared neurons/day across the account, resetting at 00:00 UTC. Workers Paid lists $0.011 per 1,000 neurons above that daily allocation; Workers Free requests above it fail rather than convert to paid usage. Before and after any live test, compare the Workers AI dashboard total for the same UTC day. Direct binding calls should not be assumed to appear in AI Gateway logs. The connected Cloudflare API returned HTTP 403 Authentication error for billable-usage info, so the account's plan and current neuron balance were not verified here; the dashboard remains the required source for actual usage. See [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Clef-flash model pricing](https://developers.cloudflare.com/workers-ai/models/clef-flash/), and [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/).

## Release gates

1. Build the exact source and verify the Worker bundle plus Workers AI binding metadata.
2. Deploy with `CLEF_ENABLED=false`, verify the running Worker revision and unchanged container image/configuration.
3. Run authenticated synthetic-provider checks for explicit-effort bypass, inferred effort, classifier failure/timeout, concurrency/budget caps, and unchanged streaming/cancellation behavior.
4. Enable the flag only after those checks pass; observe actual Clef calls, Workers AI usage, and error rates before widening traffic.

This change does not enable Clef in production in this branch. Production remains on its currently verified version until the authenticated rollout gates can be completed.
