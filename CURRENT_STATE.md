# SSI AIMS — State Index

Lightweight index that points at the current snapshot and the dated session log. Goal: keep tokens out of context unless a question actually needs deep state. Read sub-files only when relevant.

- **Always-current snapshot:** [`docs/state/snapshot.md`](docs/state/snapshot.md) — what's running, backend, frontend, dev tooling, known issues, architectural debt, next steps. Refresh whenever a session changes the shape of any service.
- **Dated session log:** [`docs/state/log/`](docs/state/log/) — per-session notes (E2E validations, refactors, open investigations). Append a new file; never edit historical entries.
- **Roadmap and burn list:** [`docs/v1/plan.md`](docs/v1/plan.md).
- **Onboarding:** [`README.md`](README.md). **Conventions:** [`AGENTS.md`](AGENTS.md).
- **Archived POT-era reference:** [`FUTURE_STATE_POT_ARCHIVED.md`](FUTURE_STATE_POT_ARCHIVED.md).

## Session log

Most recent first.

| Date | Title | Summary |
|---|---|---|
| 2026-05-05 | [Collision window fix + live VLM validation against two providers](docs/state/log/2026-05-05-collision-window-and-vlm-live-validation.md) | Closes 2026-05-03's open question. The (9, 10) `vehicle_collision` rejection wasn't a Cosmos-2B capacity issue — the 8-second clip ended right where the debris started. Widened `vehicle_collision` window 8s → 20s; `gpt-5.4-mini` and `alibaba/qwen3.5-flash` both flip from rejected (0.93-0.95) to confirmed (0.95-0.98), explicitly citing the debris. Also fixed `response_format=json_object` rejection from the Vercel AI Gateway. |
| 2026-05-04 | [Upload queue + VLM provider seam](docs/state/log/2026-05-04-queue-and-provider-seam.md) | Serial in-process job queue replaces single-tenant `current_video_id` race. Swappable VLM provider — `cosmos` (NIM) or `openai` (`gpt-5.4-mini`) — selected by env. `cosmos` compose service moved under `profiles: [gpu]`. 31/31 backend tests pass. |
| 2026-05-03 | [Rule tuning + dedup + Cosmos-2B aftermath investigation](docs/state/log/2026-05-03-rule-tuning-pickup.md) | `vehicle_collision` rule loosened (OR co-stop, max stationary tail, iou_frames_min 3→2). Per-rule VLM clip windows. Events table dedup (612k→39k). Open question: Cosmos-2B rejects the `91_Country_Club` collision aftermath — try 8B or OpenAI provider next. |
| 2026-05-03 | [Shadeform A100 runbook revalidation](docs/state/log/2026-05-03-shadeform-a100-revalidation.md) | Cold deploy from clean clone, all 8 acceptance checks passed. TRT compile ~3 min, second-boot 13 s, Cosmos-2B cold-load ~4 min. |
| 2026-04-30 | [Brev A6000 end-to-end pipeline validation](docs/state/log/2026-04-30-brev-a6000-e2e.md) | First end-to-end run. 16,526 detections / 70 tracks / 4 classes on `115_and_HVP.mp4`. Cold-deploy gotchas catalogued. |

## How to use this

- **Looking for what's running right now?** [`docs/state/snapshot.md`](docs/state/snapshot.md).
- **Curious why something looks the way it does?** Skim the session log table; open the relevant dated entry.
- **Starting a new session that lands a meaningful change?** Append `docs/state/log/YYYY-MM-DD-<slug>.md` and update the table above. Refresh `snapshot.md` if the change is structural (new module, env var, deploy mode, schema column, etc.).
