# Multi-user uploads + parallel GPU processing

## Status: planned (2026-05-11)

Two coupled work streams. Phase A–E enable logical per-user isolation on top of the existing Supabase auth. Phase F lifts the single-GPU-stream bottleneck so concurrent users don't queue behind each other end-to-end.

## Context

Supabase JWT auth shipped in `feat/supabase-auth` ([phases/supabase-auth.md](./supabase-auth.md)). Tokens flow from the Next.js middleware ([frontend/src/middleware.ts:27-29](../../../frontend/src/middleware.ts#L27-L29)) into the FastAPI `require_user` dependency ([backend/app/auth.py](../../../backend/app/auth.py)), and every `/api/*` router is gated ([backend/app/main.py:160-166](../../../backend/app/main.py#L160-L166)). **But data isn't isolated**: the `uploads` table has no `user_id` column ([backend/app/schema.sql:1-11](../../../backend/app/schema.sql#L1-L11)) and `uploads_list.py` returns every row to every signed-in caller. Likewise `playback.py` will serve any video file by id.

Concurrency today:

| Limit | Value | Source |
|---|---|---|
| HTTP uploads in flight | ~5–10 | uvicorn worker count; 500 MB body cap at [main.py:81](../../../backend/app/main.py#L81) |
| Queued waiting for GPU | **10** | `UPLOAD_QUEUE_MAX_DEPTH` at [upload_queue.py:20](../../../backend/app/upload_queue.py#L20); 11th returns 503 |
| Processing on GPU | **1** | Single asyncio worker, `vss-rt-cv` container restart per job ([upload_queue.py:266-288](../../../backend/app/upload_queue.py#L266-L288)) |

The doc drift in `AGENTS.md:84` ("No auth (dropped in the pivot)") is also stale and gets corrected as part of this work.

## Phase A — Data isolation (backend)

Goal: every user sees and acts on only their own uploads / events / incidents / playback.

1. `schema.sql`: `ALTER TABLE uploads ADD COLUMN user_id TEXT`. Nullable for legacy rows. Add `CREATE INDEX uploads_user_uploaded ON uploads (user_id, uploaded_at DESC)`.
2. `upload.py`: `user = Depends(require_user)`, write `user_id = user["user_id"]` into the INSERT. Prefix `video_id` with a short user hash (`{safe_stem}-{user_short}-{ts}`) so ids aren't trivially guessable across tenants.
3. `uploads_list.py`: every SELECT scoped by `WHERE user_id = $current_user`. DELETE / GET-by-id likewise. Return **404 (not 403)** for other users' rows to avoid existence leaks.
4. `playback.py`: ownership check before `FileResponse`. Highest-leak surface (raw MP4).
5. `incidents.py`, `events.py`: same ownership filter.
6. WebSocket events route is currently un-gated and leaks per-video data. Add token-via-query-param auth and verify against `require_user`. Already flagged at [main.py:162](../../../backend/app/main.py#L162).

Skip Postgres RLS — backend uses a single asyncpg role; app-layer enforcement at the existing auth boundary is simpler.

## Phase B — Queue fairness (backend, optional for v1)

The queue is FIFO. Two users uploading 5 videos each = one user waits for the other to drain entirely. Two options:

- **Cheap**: keep FIFO; cap per-user concurrent enqueues (e.g., 3) so no one can monopolize the 10-slot queue.
- **Better**: round-robin pop from per-user sub-queues in `upload_queue.py`. Small change once Phase F's semaphore lands.

Recommend cheap until measurement justifies otherwise. Revisit as F6.

## Phase C — Frontend

- Verify `frontend/.env.local` has `NEXT_PUBLIC_SUPABASE_URL` + anon key (it should from the auth phase).
- `src/lib/uploads.ts` and the uploads pages already route through middleware — the Bearer header travels automatically once backend filters by `user_id`. No code change.
- Add a "signed in as …" chip + sign-out button in `app-sidebar.tsx`.
- Map backend 401 to "session expired, please sign in again" instead of a generic toast.

## Phase D — Docs reconciliation

- `AGENTS.md`: replace "No auth (dropped in the pivot)" with one line on the actual auth model.
- New `docs/v1/auth.md` (or fold into `architecture.md`): token flow, `user_id` column, app-layer scoping rationale.
- `docs/v1/gotchas.md`: note that multi-user is logical isolation; GPU pipeline parallelism is Phase F.

## Phase E — Legacy row migration

Existing rows have no `user_id`. Pick one:

- **(a) drop them** — dev environments.
- **(b) assign to a designated admin user** — recommended for any stateful host.
- **(c) keep visible only to `role=admin` JWT claims** — only if we need to add admin tooling.

Decision before A1 lands: probably (b) with an env-supplied `LEGACY_OWNER_USER_ID`.

## Phase F — Parallel GPU processing

Goal: multiple uploads process concurrently on the same GPU host. Target `MAX_CONCURRENT_STREAMS=2` initially, tune up after F5.

> **Architecture decision (2026-05-12, re-validated on AWS L4):** wrap uploads as RTSP sources and feed them through NVStreamer's RTSP path — the code path NVIDIA actually tests in VSS. The previous "deferred — wait for NVStreamer 3.2.0" framing was based on a misdiagnosis of the upstream bug; see [`../../state/log/2026-05-12-nvstreamer-rediagnosis.md`](../../state/log/2026-05-12-nvstreamer-rediagnosis.md). The file-streamer adapter has a real bug in this image (stripped FFmpeg runtime deps), but the RTSP path works cleanly and is the demo path.

### Root cause of serialization

Three coupled singletons; only one is architectural:

1. **`current_video_id` Redis key** — read by the indexer to tag every event ([event_indexer.py:154](../../../backend/app/event_indexer.py#L154)). Architectural blocker.
2. **`current_stream_url.txt` + container restart per job** ([upload_queue.py:184-190](../../../backend/app/upload_queue.py#L184-L190)). Policy choice. `ds-start.sh` already comments "SDR manages stream sources dynamically".
3. **`remove_active_stream()` before every register** ([upload.py:197-198](../../../backend/app/upload.py#L197-L198)). Policy choice. SDR supports many.

DeepStream side is closer to multi-source than the Python side: `dstest5_msgconv_sample_config.txt` declares `[sensor0..sensor3]`; `metropolis_perception_app` runs an nvstreammux that natively muxes N sources.

### Path: mediamtx + NVStreamer RTSP + SDR multi-source, one DeepStream container

Validated end-to-end on AWS L4 (2026-05-12). Per upload:

```
1. file lands at /data/videos/<id>.mp4
2. backend ensures mediamtx is up (single shared compose service)
3. backend launches ffmpeg looped publisher:
     ffmpeg -re -stream_loop -1 -i <file> -c copy -f rtsp rtsp://mediamtx:8554/<id>
4. backend POSTs to NVStreamer:
     POST /api/v1/sensor/add
     {"name":"<id>","sensorUrl":"rtsp://mediamtx:8554/<id>",
      "location":"","tags":"","username":"","password":""}
   → returns {"sensorId":"<uuid>"}
5. NVStreamer probes via GStreamer RTSP DESCRIBE (works — no libav involvement),
   assigns proxy URL: rtsp://<nvstreamer>:30554/live/<uuid>
6. backend hands that proxy URL to SDR (or directly to DeepStream nvstreammux REST),
   nvstreammux adds the source dynamically — no container restart
7. events flow out tagged with sensorId
8. on plateau / hard timeout:
   - backend kills the ffmpeg publisher for <id>
   - backend DELETE /api/v1/sensor/<uuid>  (NVStreamer unregisters)
   - SDR / nvstreammux drops the source
```

Do **not** fan out into N containers — GPU memory + engine duplication cost is real and the dynamic-source mechanism is the point of `metropolis_perception_app`.

### F1. Per-event source tagging *(the real fix)*

- Spike first: run two synthetic publishers with distinct sensor ids, inspect actual `mdx-raw` payload shape. DS msgconv payload-type 1 typically emits `sensorId`; verify before committing the indexer rewrite. If payload-type 1 lacks it, switch to payload-type 2 (full schema) or the `sensor-id-list` mechanism.
- `event_indexer.py`: stop reading `current_video_id` from Redis. Take `video_id` from `meta["sensorId"]` (or whichever key DS uses). Per-video fps cache stays. Unknown sensor_id → drop + increment orphan counter (same as today's branch).
- Keep the Redis singleton write in place for one release behind a feature flag (`MULTI_STREAM_ENABLED`) so rollback is safe.

### F0. File-to-RTSP shim (new — gates everything else in F)

- Add `mediamtx` as a compose service on `vss-net`, listening on `8554/tcp` (RTSP) internally only. No external port exposure.
- New backend module `rtsp_publisher.py`: starts/stops a per-upload `ffmpeg -re -stream_loop -1 -i <file> -c copy -f rtsp rtsp://mediamtx:8554/<id>` subprocess. Tracks PID by `video_id`; teardown on plateau / timeout / failure / process death.
- New `sdr.py` rewrite (or rename to `nvstreamer.py`): replaces the broken `POST /api/v1/file` calls with the real API: `POST /api/v1/sensor/add` with the validated payload schema (`name`, `sensorUrl`, `location`, `tags=""`, `username=""`, `password=""`), `DELETE /api/v1/sensor/<uuid>`, `GET /api/v1/sensor/list`. Returns the assigned proxy URL for the caller to hand to DeepStream.
- Verify `mediamtx` is reachable from inside the NVStreamer container by service name (`rtsp://mediamtx:8554/...`) — both on the same compose network.

### F2. Concurrency budget + admission control

- New env: `MAX_CONCURRENT_STREAMS` (default 2).
- `upload_queue.py`: replace single-active-job worker with a semaphore. Up to N `_process_job` coroutines run concurrently; each owns its own plateau watcher. `UPLOAD_QUEUE_MAX_DEPTH=10` stays — that's the backlog past parallel capacity.
- **Delete** the `current_stream_url.txt` write and the `_restart_container` call ([upload_queue.py:184-190](../../../backend/app/upload_queue.py#L184-L190)). DeepStream stays running; sources are added/removed dynamically.
- **Delete** `remove_active_stream()` from `upload.py` ([upload.py:206-207](../../../backend/app/upload.py#L206-L207)). Worker calls the new `nvstreamer.unregister_sensor(uuid)` + `rtsp_publisher.stop(video_id)` after plateau or hard timeout.

### F3. Per-video plateau watcher

Current plateau loop already polls `SELECT count(*) FROM events WHERE video_id=$1` — per-video, just runs N in parallel now. Verify it doesn't thrash the DB at N=4 (one SELECT/sec/video should be fine).

### F4. NVStreamer client + publisher teardown

Subsumed by F0. After plateau / timeout / failure, worker calls:

1. `nvstreamer.unregister_sensor(sensor_uuid)` — `DELETE /api/v1/sensor/<uuid>` (also triggers SDR / nvstreammux source removal)
2. `rtsp_publisher.stop(video_id)` — terminates the ffmpeg process; reaps the pipe
3. NVStreamer's stream_monitor will detect the upstream RTSP source disappearing within ~5s and clean up its own state if (1) is skipped — but call both for cleanliness.

### F5. Capacity probe (empirical)

Run synthetic publisher with N=1,2,3,4 concurrent streams. Measure:

- per-stream sustained FPS
- GPU memory (`nvidia-smi`)
- indexer lag (`xinfo_groups → lag`)
- DB write rate, `executemany` latency

Pick production default for `MAX_CONCURRENT_STREAMS` from the elbow. Rough priors: T4 → 2, L4/A10 → 4, H100 → more. Document the curve in `docs/v1/gotchas.md`.

### F6. Per-user fairness *(depends on Phase A)*

Once N>1 *and* Phase A has landed, FIFO inside the queue still lets one user grab all N slots. Replace `asyncio.Queue` with per-user sub-queues + round-robin pop. Small change once F2's semaphore is in place.

### What stays serial (intentionally)

- `nvstreamer` upload step — only for RTSP-backed inputs. `file:///data/videos/...` mode doesn't use it.
- VLM validator — already per-incident async; no change.
- Event indexer — single consumer is fine; I/O-bound. Scale out only if `stream_lag` grows under sustained N>4.

### Risk register

- **DS engine rebuild on first run** (~60–120s). One-time, harmless.
- **msgconv source-id field name** — must verify in F1 spike before rewriting the indexer. Easy to find out, hard to retrofit.
- **DB pressure at N>4** — `executemany` with the dedup unique index is the first thing to feel it. Mitigation: COPY-based batch insert. Not now.
- **Plateau false positives across overlapping streams** — should be irrelevant once each watcher only counts its own video, but verify under load (two short videos finishing within seconds of each other).

## Sequencing

| Order | Phase | Depends on | Effort |
|---|---|---|---|
| 1 | A — data isolation (commit; already implemented) | supabase-auth (shipped) | <1 hr |
| 2 | F0 — file→RTSP shim (mediamtx + ffmpeg publisher + NVStreamer client rewrite) | A | ~½ day |
| 3 | F1 spike — verify `sensorId` in `mdx-raw` payload | F0 (need a real NVStreamer source to inspect) | ~½ day |
| 4 | F2–F4 — semaphore, drop `current_stream_url.txt`/restart, teardown wiring | F0 + F1 confirmed | ~1 day |
| 5 | D — docs reconciliation | F0–F2 | ~1 hr |
| 6 | F3 — per-video plateau watcher (already per-video; verify under N) | F2 | ~¼ day |
| 7 | F5 — capacity probe (N=1..4 on the target GPU) | F2–F4 | ~½ day |
| 8 | E — legacy row migration | A | ~½ day |
| 9 | C — frontend polish (signed-in chip, 401 toast) | A | ~½ day |
| 10 | B / F6 — fairness (per-user sub-queues) | A + F2 | ~½ day |

Total: ~3.5–4 focused days for the **demo target** (A + F0–F4 + D), ~5 days including E, C, B/F6 polish.

## Smallest demo-able slice

For the **multi-user + parallel processing demo target**: A + F0 + F1 + F2 + F4. Skipping F0 means no parallelism. F1 can land in the same PR as F0 since the spike needs a working NVStreamer source to inspect.

For a **logical-isolation-only slice** (single-stream, no parallelism): A + D. One PR; matches the old "smallest viable slice."

## Out of scope

- Org/team hierarchy, sharing, roles — pivot says single-tenant.
- Postgres RLS — single asyncpg role makes app-layer scoping simpler.
- Per-user storage paths on disk — `video_id` is the unique key; `playback.py` ownership check is the actual control.
- N DeepStream containers — Path B from the discussion. Heavier ops, no GPU benefit over SDR multi-source.
