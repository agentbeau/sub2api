# Preview acceptance record — 2026-11-13

## What is deployed and what is source-only

The existing preview received a narrowly scoped binding-adapter hotfix. No additional Worker was created, and production was not changed. The durable source correction is in `src/preview.ts` with regression coverage in `test/preview-bindings.test.ts` (PR #12).

The fault was that public dispatch adapted `ENGINE` to the inherited engine contract, but the exported Engine and R2Bridge constructors did not. Both constructors now receive the same adapted environment, preserving the state binding and access checks.

The direct hotfix reused the prior live JavaScript and Wasm bytes and added the tested constructor adapter. Artifact hashes were compared before and after upload. This is **not** a clean Rust/provider-container rebuild. The container image was unchanged.

The newer Durable Object scheduling policy in PR #11 is **not deployed**. It remains isolated preparation; do not create an additional live Worker as part of this handoff. The intended deployed footprint remains main plus existing preview/enhanced Worker.

## Completed checks

- 32 focused preview-access, binding-adapter and background-activity tests passed.
- Actual local workerd probes rejected unauthorized/forged identities.
- Actual bridge-to-engine RPC reached the sleeping engine instead of failing namespace resolution.
- Live authenticated readiness and model listing succeeded.
- Live bounded text and image generation returned HTTP 200.
- Containers returned to inactive after the completed tests; no continuous keepalive was introduced.

These are scoped acceptance checks, not proof that every endpoint or disconnection/retry path works.

## Timing interpretation

All timings are single samples from a remote cloud client and include network/TLS overhead. They are not stable model rankings or isolated container boot measurements.

| Probe | Observed |
|---|---:|
| Cold runtime readiness | 4.62 s total, including 2.67 s establishing connection/TLS |
| Warm readiness | 3.31 s total, including 2.91 s establishing connection/TLS |
| Warm streamed text | 4.00 s first content; 4.52 s complete |
| One cold image request | 15.46 s complete |

The earlier 6.26-second text result measured the **whole request**, not startup. Millisecond Worker-isolate startup is not the same as Linux-container readiness plus inference. The post-TLS difference still includes access processing, routing and application readiness, so it must not be labeled pure boot time.

## Request lifecycle and cost controls

The observed preview configuration retains one small container and a 1,000 ms base idle timeout. One second is an idle grace period, not a request execution deadline. Active HTTP/streaming work keeps the runtime active. Background operations use bounded renewable activity holds, and editing windows are explicitly released after tests.

This minimizes idle use but may cause cold starts between separate requests. A 30–60 second conversational grace is a candidate, **not an applied change**. One-instance and idle limits are not a hard monetary or model-token cap. Disconnected clients and very long background-only provider work remain untested.

## Routing

The preview strategy was explicitly changed from `round-robin` to `fill-first` and read back successfully. Fill-first selects the first eligible credential from the highest eligible priority bucket using deterministic ordering. It does not inherently mean a named subscription/account is primary. Per-request chosen account was not established. No provider-account priorities or model selections were altered by these tests.

## Image and GIF findings

Three low-quality image-model tests returned valid PNGs but produced 1536 × 1024 despite requesting 1024 × 1024. Treat this as an unresolved size-contract discrepancy, not a successful square-output test.

The official animated-image request was also tested with `output_format: gif`, `size: 512x512`, `frame_count: 9`, `frame_duration_ms: 200`, and `n: 1`. The response was HTTP 400: `GIF output is not enabled for this request.` Official documentation describes GIF-preview access; this result does not establish whether the restriction is in the gateway or upstream entitlement. No generated still was represented as animation.

See [the saved richer comparison](creative-model-comparison.md) for the exact creative brief and full text outputs. Those are draft model outputs, not deployed site content.

## Integration and unfinished work

1. Integrate the source binding correction into the active preview branch before resuming its automatic deployment. An older successful build could otherwise overwrite the direct hotfix.
2. Keep production's branch, credentials, storage, and deployment unchanged. Do not merge the entire preview branch into main merely to exercise CI.
3. Full clean Rust/Wasm/container verification is pending. GitHub checks were queued/absent and the last Cloudflare build's GitHub provenance request returned 403. Logs did not establish why; provenance checks were not weakened.
4. GitHub CI has **not** been disabled. The available automation interface did not expose that operation. No workflow-source edit or branch-protection change was used as a substitute.
5. Preview versus main inference comparison remains incomplete; these results concern preview only.
6. No credentials, tokens, private configuration, account identifiers or authentication files belong in this record or repository.

## Official references

- https://developers.cloudflare.com/containers/platform-details/architecture/
- https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout
- https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output
- https://developers.openai.com/api/reference/resources/images/methods/generate
