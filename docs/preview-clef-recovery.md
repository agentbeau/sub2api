# Enhanced-only Clef deployment hardening

2026-11-13: First classifier upload omitted container metadata. Subsequent repaired upload and ordinary rollback were tested inside Cloudflare's default 300-second Durable Object code-update deferral. Missing container capability reproduces the observed 503 in integration tests. Deferral explains the observed sequence but retrospective DO-version evidence is unavailable; do not claim a conclusively proven incident cause.

Recovery deployed exact prior version 7059fc14-f9ac-4c31-8320-17822be183cd with immediate DO code update. Authenticated generation and dashboard returned 200. Main remained unchanged.

Deployment procedure: full tests, stage through versions POST without routing traffic, inspect exact bindings/container metadata, confirm quiet runtime, deploy immediate DO code update, verify private status revision/capability, then bounded synthetic inference. Roll back immediately to known-good version using the same immediate strategy on regression. Never auto-deploy a raw script upload. No container-image rollout, R2 configuration write, account change, model change, or AI Gateway is included.

Private status includes nonsecret per-incarnation Clef call/application counters and revision/capability headers, not queries, instructions or credentials. Counters reset with the Durable Object. They are diagnostics, not durable billing records.

Cloudflare official code-update semantics: https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/
