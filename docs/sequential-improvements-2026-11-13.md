# Sequential gateway improvements

## Completed
- Binding repair merged into isolated branch: 38c8698164df5940188c5ff9118803a8fc965dd3. 32 preview/access/activity tests passed.
- Cloudflare gateway-preview source-change builds suppressed with path_excludes ["*"]. Manual build capability and provenance checks retained. Main Worker unchanged. GitHub Actions are not disabled.
- Preview idle changed from 1 to 30 seconds; source commit 250d8cf7527cd701f97452a08d15af05b077ce3d. 87 lifecycle/activity tests pass. Three different nonce prompts succeeded with zero cached tokens: 7.253 seconds cold, 5.342 and 5.083 seconds subsequent. TLS alone took 2.719–3.340 seconds. Total 141 tokens. Runtime remained active between requests and returned to sleep after 35 seconds idle. Small sample, not a latency guarantee. Maximum one instance preserved; each isolated wake may add up to29 idle seconds versus previous setting.

## Image investigation, not fixed
Pinned provider v8.0.67 commit 8bba7a77c6bcbfd993516d26606bfecaa4ff49d0 was tested locally against a fake HTTP endpoint, no live inference or real credentials. Six cases passed for gpt-image-2.6, sunburst and flare, each PNG and GIF. Model, prompt, size, n, output_format, frame_count and frame_duration_ms were preserved. Native /images/generations route observed.

Reproduce: copy test/fixtures/upstream/dagul_image_contract_test.go into internal/runtime/executor of the pinned provider checkout, then run go test ./internal/runtime/executor -run '^TestDagulImageContract$' -count=1 -v with Go1.26.10. The fixture is not part of this repository's Vitest run.

This rules out unconditional field loss in the adapter with empty test configuration. It does not prove live payload overrides, account entitlement or upstream size handling. Existing square-size mismatch and GIF rejection remain unresolved. No speculative image patch or further paid image calls made. Next needed evidence is a redacted outbound field trace or narrow non-secret payload-rule inspection, not a full configuration dump.

## Next stage, not implemented
Routing visibility should expose only a stable account alias, request ID, model, strategy, attempt, status and elapsed time on the existing authenticated management surface. Internal usage records contain secrets: never serialize them wholesale. Reasons must be captured at the selector, not inferred from the final account.
