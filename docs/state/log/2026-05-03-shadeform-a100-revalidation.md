# 2026-05-03 — Shadeform A100 80 GB runbook revalidation

**Host:** Fresh Shadeform A100 80 GB VM, driver 580.

Cold deploy from a clean clone. All 8 acceptance checks (A1–A8) passed.

## Timing

- TRT engine compile: ~3 min on A100 (vs 3.5 min on A6000)
- Second-boot from cache: 13 s
- Cosmos-Reason2-2B cold-load: ~4 min (faster than the 10–15 min predicted in the runbook)

## What worked end-to-end

Ingest → rule pack → VLM validation. Deduped events flow now landed (the schema unique index + indexer ON CONFLICT DO NOTHING from this same session — see [2026-05-03 rule tuning pickup](2026-05-03-rule-tuning-pickup.md)).

## Public access note

VS Code port forwarding on `3000` (UI) and `8080` (backend API). Direct public access blocked by Shadeform's default security group; public IP was `154.54.100.247`.
