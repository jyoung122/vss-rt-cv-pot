# 2026-05-03 — Rule tuning + dedup + Cosmos-2B aftermath investigation (session paused)

This session refactored a lot. Read this first when picking up the Cosmos-2B vs 8B investigation. **The machine was being brought down**; bring it back up with `docker compose up -d` (no `--build` needed unless code changed since you left).

## Open question being investigated

`91_Country_Club.mp4` contains a real collision around t≈15-23 s (debris visible around a stopped car). After all the cleanup below, the rule pack DOES detect the impact — fires `vehicle_collision` on tracks (9, 10) at t=15.1-15.3 s, IOU peak 0.493. But Cosmos-Reason2-**2B** rejects the (correctly-extracted) 8 s clip with confidence 0.95, saying "no collision evidence." The clip window does cover the impact moment. Either the 2B model lacks the visual reasoning for subtle aftermath, or our prompt still isn't sharp enough.

## Immediate next step (decided, not yet executed)

Two viable paths from here:

**Path A — Cosmos 8B swap.** Change [`docker-compose.yml`](../../../docker-compose.yml) `cosmos.image:` to `nvcr.io/nim/nvidia/cosmos-reason2-8b:latest`, run `docker compose pull cosmos && docker compose --profile gpu up -d cosmos`, wait ~10 min for first-boot weight load (~30 GB image, ~16 GB BF16 in VRAM — fits comfortably alongside DeepStream's 3 GB on the A100 80 GB). Now also a no-code change since `COSMOS_MODEL` is env-driven (landed [2026-05-04](2026-05-04-queue-and-provider-seam.md)).

**Path B — OpenAI provider.** With the [VLM provider seam landed 2026-05-04](2026-05-04-queue-and-provider-seam.md), `VLM_PROVIDER=openai` + `OPENAI_API_KEY` + `OPENAI_MODEL=gpt-5.4-mini` runs the same incident through GPT instead. Cheaper hardware path (no 8B VRAM requirement); per-call cost; egress.

Either way, the test query is `curl -X POST http://localhost:8080/api/uploads/91_Country_Club-1777844748/analyze` and check the (9, 10) verdict. The API contract is identical across providers — no backend code change required.

## Tracker-break finding (separate issue, document only)

DeepStream's IOU tracker loses track 10 right at impact (track ends at t=15.3 s). The same physical car re-enters the scene 6 s later as track 18 (t=21.5 → 25.8 s). Tracks (9, 18) overlap again post-impact at t=24.2-24.5 (IOU 0.482) — that's the "cars-still-touching aftermath" — but it doesn't fire `vehicle_collision` because track 18 ends 1.3 s after the overlap, and the velocity-drop signal from the already-stationary track 9 is near zero. Track-break stitching is the proper upstream fix; out of scope for the demo.

## Rule tuning landed in this session

- `vehicle_collision` co-stop check changed from `a_stop AND b_stop` to **`a_stop OR b_stop`** — catches stopped-car-rear-ended scenarios (the stationary side has near-zero "drop").
- `vehicle_collision` stationary-tail check changed from `stat_a + stat_b ≥ 3s` to **`max(stat_a, stat_b) ≥ 3s`** — admits hit-and-runs where only the struck car has a long tail.
- `vehicle_collision.iou_frames_min` lowered **3 → 2** to catch glancing impacts.
- `vehicle_collision` metadata now includes **`iou_peak_t`** (the time of the highest-IOU frame in the overlap window) so the VLM validator can centre its clip extraction on the actual contact moment.
- `mass_stop` results now post-clustered through **`_merge_overlapping`** — sweep-line interval merge collapses sliding-window anchor firings to one densest event per real brake wave (most tracks → longest span → earliest start). `metadata.merged_firings` records how many anchors got absorbed. Drops `mass_stop` count on busy clips by ~3-4× without losing real events.

## VLM validator clip-window changes

[`backend/app/vlm_validator.py`](../../../backend/app/vlm_validator.py) `_clip_window` now extracts per-rule windows instead of `[t_start_s - 2s, t_end_s + 2s]`:

- `vehicle_collision`: `[iou_peak_t - 2s, +6s]` (8 s, centred on contact frame; falls back to `t_start_s` if metadata missing)
- `ped_impact`: `[t_start_s - 2s, +6s]` (8 s)
- `stationary_vehicle`: `[t_start_s, +8s]` (8 s)
- `mass_stop`: `[t_start_s - 1s, +4s]` (5 s)
- Unknown rule: legacy full-span fallback

Changed because Cosmos-Reason was averaging across the rule's full incident span (sometimes 45+ s) and concluding "mostly normal traffic" — the diagnostic moment was too small a fraction of the clip. Tight focused clips improve VLM confidence and run faster.

## Events table dedup

Added unique index `events_dedup` on `(video_id, frame_id, track_id)` and indexer `INSERT ... ON CONFLICT DO NOTHING`. DeepStream's `-r 2` loop replays were appending duplicate detection rows (per-track signals were computed across multiple physical objects sharing IDs across iterations). The dedup dropped event counts from ~612k → ~39k across three uploads (~94 % reduction) and made the rule pack's per-track signals trustworthy again.

## Live system state when the machine came back up

- Branch: `main`. Working tree had uncommitted changes across `backend/app/{event_indexer,incident_worker,vlm_validator,uploads_list}.py`, `backend/app/schema.sql`, `backend/tests/test_incident_worker.py`, `backend/tests/test_uploads_progress.py` (new), `frontend/src/app/uploads/page.tsx`, `frontend/src/app/uploads/[video_id]/page.tsx`, `frontend/src/lib/use-upload-progress.ts` (new), `frontend/src/lib/tour.ts`, plus `docs/v1/upload-progress.md` (new) and `CURRENT_STATE.md`. (All committed in subsequent sessions.)
- DB had 5 uploads (incl. `91_Country_Club-1777844748` and `115_and_HVP-1777838948`) and ~39 k deduped events.
- `.env` had `VLM_ENABLED=true` and a real `NGC_CLI_API_KEY`. Cosmos-2B image cached locally; `aims-cosmos-cache` named volume held the weights.
