# Enhanced Worker: bounded effort classifier

Status: implemented locally; not deployed or live-acceptance-tested. Production is unchanged.

## Single destination

Agent → existing enhanced Worker/Access gate → KeyGuard → optional Clef effort decision → unchanged existing proxy route → provider.

This is **not** AI Gateway response caching, provider prompt caching, a new Worker, a router to other providers, or a new public API. Routing and required internal proxy authentication headers remain deterministic in the existing forwarder. Clef does not receive or choose credentials, headers, destinations, or URLs.

## Admission and privacy

Only KeyGuard's confirmed `allowed` keys qualify, outside the management mutation grace window. Plugin/runtime-only authentication bypasses classification and retains normal native validation. Clef receives only the final user message's text (max 2,048 UTF-16 code units), plus fixed classification criteria. It never receives HTTP headers, prior messages, system/developer instructions, tool definitions/results, or attachments. The complete original request proceeds downstream; the classifier does not summarize or replace it. A lossless field insertion preserves original bytes, whitespace, and large numeric values; JSON is parsed only to inspect eligibility. Obvious context-dependent follow-ups such as “continue” bypass classification.

Supported POST routes: `/v1/chat/completions`, `/v1/responses`. Supported exact model IDs: `gpt-6-luna`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6.1-sol`. Their low/medium/high support is recorded in the pinned engine catalog at commit `8bba7a77c6bcbfd993516d26606bfecaa4ff49d0`, `internal/registry/models/models.json`. Unknown aliases and model suffixes bypass classification.

Explicit effort always wins, including explicit invalid values left for native validation. Otherwise `@cf/cloudflare/clef-flash` chooses low, medium, or high. Selected-class probability must be at least 0.8. Uncertain answers fall back to the original request and its existing provider/default behavior, not a forced low effort.

## Limits and fallback

- Body inspection: max 65,536 bytes; 150 ms read deadline.
- Classifier: 600 ms AI waiting deadline, no retry. Budget storage time is additional; this is not a strict 600 ms end-to-end overhead guarantee.
- Persistent singleton budget: 10 reservations/minute, 100/day UTC; failed and timed-out calls count.
- At most two in-flight preparations/model calls per live singleton. Timed-out AI calls retain their slot until the AI promise settles.
- Storage failure, AI failure, unsupported input, quota exhaustion, malformed data or abort: original request proceeds unchanged.
- No request bodies or credentials logged by this feature. Ledger stores only counters/time buckets.

An inference timeout stops waiting, not necessarily remote execution/billing. The two-call limit is in-memory and resets with a DO eviction; the persistent daily/minute budget remains the hard reservation cap across evictions. AI binding is private to Worker code, not scoped to a single model by the platform; the helper fixes the model for this feature. This is not independent isolation from compromised Worker code.

## Activation and rollback

Preview only needs an `AI` Workers AI binding and `CLEF_ENABLED=true`. Neither has been added to the deployed Worker. Missing binding/flag is a no-op. Main `Cpa` implementation keeps an identity hook; only preview `Engine` implements classification. No stored model/account settings are modified. Rollback: disable the flag or restore the previous enhanced Worker version, retaining all credentials and storage.

Before activation: finish pinned Rust/Wasm build, integration tests including rejected keys before AI and AI before native start, exact bundle review, authenticated synthetic live acceptance, and comparison with current version. Do not weaken Access or rotate credentials merely to gain test access.

## Evidence

Official Clef model/input schema: https://developers.cloudflare.com/workers-ai/models/clef-flash/
Binding behavior: https://developers.cloudflare.com/workers-ai/configuration/bindings/

Two earlier synthetic direct Clef calls (not full gateway tests) returned low for short arithmetic and high with insufficient probability for a difficult proof. They consumed 434 input tokens total. These timings do not measure deployed gateway end-to-end latency.
