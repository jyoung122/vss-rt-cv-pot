# SSI AIMS — Current State

Snapshot of what is actually running on `main`. For the roadmap and burn list see [`docs/v1/plan.md`](docs/v1/plan.md). For onboarding see [`README.md`](./README.md). For the in-flight 5-stage upload progress design see [`docs/v1/upload-progress.md`](docs/v1/upload-progress.md). For DeepStream-only reference material from the POT era see [`FUTURE_STATE_POT_ARCHIVED.md`](./FUTURE_STATE_POT_ARCHIVED.md).

---

## End-to-end validation

**2026-04-30 — pipeline ran end-to-end on a fresh Brev VM (A6000 48 GB, driver 580).** Uploaded `115_and_HVP.mp4` (1280×720, 15 fps, 148.8 s) via `POST /api/upload`. DeepStream → Redis `mdx-raw` → indexer → Postgres `events` flowed cleanly: 16,526 detections across 70 tracks, all four classes (car 10,891 / road_sign 2,386 / person 2,204 / bicycle 1,045), `max(t_seconds)=148.67` matching clip duration. `GET /api/uploads` and `GET /api/uploads/:id/events?group=tracks` returned correct shape. Cold-deploy gotchas (model dir perms, NGC ONNX pre-stage, frontend `.dockerignore`, postgres startup race, SDR DNS flake) catalogued in [`docs/gotchas.md`](./docs/gotchas.md).

**2026-05-03 — full runbook re-validated on a fresh Shadeform A100 80 GB VM (driver 580).** Cold deploy from a clean clone, all 8 acceptance checks (A1-A8) passed. TRT engine compile ~3 min on A100, second-boot from cache 13 s. Cosmos-Reason2-2B cold-load ~4 min (faster than the 10–15 min predicted in the runbook). End-to-end ingest → rule pack → VLM validation working. Deduped events flow now landed (see "Pickup point" below).

---

## Pickup point — 2026-05-03 (session paused mid-tuning)

This session refactored a lot. Read this section first when you come back. **The machine is being brought down**; bring it back up with `docker compose up -d` (no `--build` needed unless code changed since you left).

**Open question being investigated:**

`91_Country_Club.mp4` contains a real collision around t≈15-23 s (debris visible around a stopped car). After all the cleanup below, the rule pack DOES detect the impact — fires `vehicle_collision` on tracks (9, 10) at t=15.1-15.3 s, IOU peak 0.493. But Cosmos-Reason2-**2B** rejects the (correctly-extracted) 8 s clip with confidence 0.95, saying "no collision evidence." The clip window does cover the impact moment. Either the 2B model lacks the visual reasoning for subtle aftermath, or our prompt still isn't sharp enough.

**Immediate next step (decided, not yet executed):**

Swap the Cosmos NIM image to **`nvcr.io/nim/nvidia/cosmos-reason2-8b:latest`** in [`docker-compose.yml:183`](./docker-compose.yml#L183). One-line change. Then `docker compose pull cosmos && docker compose up -d cosmos`, wait ~10 min for first-boot weight load (~30 GB image, ~16 GB BF16 in VRAM — fits comfortably alongside DeepStream's 3 GB on the A100 80 GB), then `curl -X POST http://localhost:8080/api/uploads/91_Country_Club-1777844748/analyze` and check the (9, 10) verdict. The API contract is identical across NIM sizes — no backend code change required.

**Tracker-break finding (separate issue, document only):**

DeepStream's IOU tracker loses track 10 right at impact (track ends at t=15.3 s). The same physical car re-enters the scene 6 s later as track 18 (t=21.5 → 25.8 s). Tracks (9, 18) overlap again post-impact at t=24.2-24.5 (IOU 0.482) — that's the "cars-still-touching aftermath" — but it doesn't fire `vehicle_collision` because track 18 ends 1.3 s after the overlap, and the velocity-drop signal from the already-stationary track 9 is near zero. Track-break stitching is the proper upstream fix; out of scope for the demo.

---

## What's running

Three compose files, all stable:

- **`docker-compose.yml` — prod.** Seven services: `redis`, `postgres` (aims-postgres), `nvstreamer`, `sdr`, `vss-rt-cv` (DeepStream + GPU), `backend`, `frontend`. (`redis-commander` was dropped in Phase 3.) NVStreamer is up but not in the perception path (see "Known issues"). Healthchecks land on `redis`, `postgres`, `backend`, and `vss-rt-cv`. `frontend` `depends_on` is `service_healthy`. Backend and frontend both receive structured log env vars (`LOG_LEVEL`, `LOG_FORMAT`, `SERVICE_NAME` / `NEXT_PUBLIC_*` equivalents).
- **`docker-compose.dev.yml` — dev (no GPU).** Three services: `redis`, `postgres`, `backend`. No NGC pull. Mounts `./tools` read-only at `/app/tools`. Log env vars injected (`LOG_LEVEL`, `LOG_FORMAT`, `SERVICE_NAME`, `ENV`).
- **`docker-compose.observability.yml` — optional overlay.** Adds Loki + Promtail + Grafana (port `3002`). Provisioned Loki datasource and **AIMS Support/Dev Logs** dashboard. Apply with: `docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d` (or the `dev.yml` variant).

The DeepStream side is unchanged from the POT — `metropolis_perception_app -m 7 -r 2` runs RT-DETR (TrafficCamNet) → IOU tracker → `nvmsgconv` → `nvmsgbroker` (`libnvds_redis_proto.so`) → `XADD mdx-raw`. Source pacing comes from `sync=1` on the sinks; ~7–8 events/sec at the source's native FPS. All four classes detected (car / bicycle / person / road_sign).

---

## Backend

**Stack:** FastAPI on Python 3.11-slim, `uvicorn` with `--limit-concurrency 10`, `asyncpg` pool, `redis[hiredis]>=5`, `aiofiles`, `python-multipart`. `ffmpeg` (for `ffprobe`) is installed in the image so the upload handler can read duration / resolution / fps.

**Persistence (Postgres 16-alpine).** `backend/app/db.py` initialises the asyncpg pool at FastAPI lifespan start and runs `backend/app/schema.sql`. Three tables:

- `uploads` — `video_id` PK (per-run `{stem}-{timestamp}` so re-uploads append a new row), `original_filename`, `prompt`, `duration_s`, `width`, `height`, `fps`, `size_bytes`, `uploaded_at`.
- `events` — `id BIGSERIAL` PK, `video_id` FK with `ON DELETE CASCADE`, `track_id`, `frame_id`, `t_seconds`, `class`, `confidence`, `bbox_x1..y2`. Indexes on `(video_id, frame_id)` and `(video_id, track_id)`. **Unique index `events_dedup` on `(video_id, frame_id, track_id)` (added 2026-05-03)** — collapses duplicate detections from DeepStream's `-r 2` loop replays. Without it, every loop iteration appended a fresh row per `(frame_id, track_id)` and per-track signals (velocity drops, IOU pairs, stationary tails) were computed across multiple physical objects sharing IDs across iterations. The session 2026-05-03 dedupe dropped event counts from ~612k → ~39k across three uploads (a ~94 % reduction). The indexer pairs this with `INSERT ... ON CONFLICT DO NOTHING`.
- `incidents` — `id UUID` PK, `video_id` FK with `ON DELETE CASCADE`, `rule_id` (`vehicle_collision` / `ped_impact` / `stationary_vehicle` / `mass_stop`), `severity`, `confidence`, `t_start_s` / `t_end_s`, `frame_start` / `frame_end`, `track_ids INT[]`, `bbox_union JSONB`, `metadata JSONB`. Index on `(video_id, t_start_s)`; unique dedup index on `(video_id, rule_id, t_start_s, track_ids)`. Phase 8 added `vlm_*` columns via `ALTER TABLE IF NOT EXISTS`: `vlm_status`, `vlm_verdict`, `vlm_reasoning`, `vlm_confidence`, `vlm_model`, `vlm_clip_path`, `vlm_latency_ms`, `vlm_at`. Partial index on `vlm_status='pending'`. **Re-analyze does a full DELETE + INSERT (not ON CONFLICT)** — VLM verdicts reset to `pending` on every analyze; the validator re-queues automatically. (Earlier doc text suggested "ON CONFLICT preserves VLM verdicts" — that's outdated; the code in [`backend/app/incident_worker.py`](backend/app/incident_worker.py) `_refresh_incidents` does a clean replace.)

**Event indexer (`backend/app/event_indexer.py`).** Background asyncio task spawned at lifespan start. Uses Redis `XREADGROUP` (group `indexer`, consumer `indexer-1`, MKSTREAM), parses the pipe-delimited objects out of each `metadata` JSON envelope, looks up `current_video_id` from Redis to associate the frame with an upload, looks up `fps` from the `uploads` row (cached per-process) to compute `t_seconds = frame_id / fps`, and `executemany`s the rows. **`INSERT ... ON CONFLICT (video_id, frame_id, track_id) DO NOTHING`** so DeepStream's `-r 2` loop replays don't accumulate duplicate detections (added 2026-05-03; works in concert with the `events_dedup` schema index). Poison-pill safe: ack on success or on parse error, retry the outer loop on connection errors.

**Incident worker (`backend/app/incident_worker.py`).** Pixel/track-space rule pack run on demand via `POST /api/uploads/:id/analyze`. Loads all events for the video, builds per-track signals (bisect-windowed velocity, velocity-drop ratio, stationary duration, bbox-aspect change) keyed on `(track_id, normalized_class)` so DeepStream's case-mixed class strings don't split tracks. Pairwise pass computes IOU overlap, centroid proximity, and co-stop. Four rules fire: `vehicle_collision` (sustained IOU + co-stop + stationary tail), `ped_impact` (centroid proximity + person track terminate-or-stop), `stationary_vehicle` (long stop with prior motion to filter parked cars), `mass_stop` (cluster of vehicles sharing a sudden velocity drop). On every analyze: full `DELETE FROM incidents WHERE video_id=$1` + insert fresh — VLM verdicts reset to `pending` and the validator re-queues.

**Rule tuning landed 2026-05-03:**
- `vehicle_collision` co-stop check changed from `a_stop AND b_stop` to **`a_stop OR b_stop`** — catches stopped-car-rear-ended scenarios (the stationary side has near-zero "drop").
- `vehicle_collision` stationary-tail check changed from `stat_a + stat_b ≥ 3s` to **`max(stat_a, stat_b) ≥ 3s`** — admits hit-and-runs where only the struck car has a long tail.
- `vehicle_collision.iou_frames_min` lowered **3 → 2** to catch glancing impacts.
- `vehicle_collision` metadata now includes **`iou_peak_t`** (the time of the highest-IOU frame in the overlap window) so the VLM validator can centre its clip extraction on the actual contact moment.
- `mass_stop` results now post-clustered through **`_merge_overlapping`** — sweep-line interval merge collapses sliding-window anchor firings to one densest event per real brake wave (most tracks → longest span → earliest start). `metadata.merged_firings` records how many anchors got absorbed. Drops `mass_stop` count on busy clips by ~3-4× without losing real events.

**VLM validator clip-window changes (2026-05-03).** [`backend/app/vlm_validator.py`](backend/app/vlm_validator.py) `_clip_window` now extracts per-rule windows instead of `[t_start_s - 2s, t_end_s + 2s]`:
- `vehicle_collision`: `[iou_peak_t - 2s, +6s]` (8 s, centred on contact frame; falls back to `t_start_s` if metadata missing)
- `ped_impact`: `[t_start_s - 2s, +6s]` (8 s)
- `stationary_vehicle`: `[t_start_s, +8s]` (8 s)
- `mass_stop`: `[t_start_s - 1s, +4s]` (5 s)
- Unknown rule: legacy full-span fallback

This was changed because Cosmos-Reason was averaging across the rule's full incident span (sometimes 45+ s) and concluding "mostly normal traffic" — the diagnostic moment was too small a fraction of the clip. Tight focused clips improve VLM confidence and run faster (clip extraction + base64 encode is shorter).

**Endpoints.** `POST /api/uploads` (multipart; saves file, ffprobes, inserts uploads row, sets `current_video_id`, restarts vss-rt-cv via Docker socket). `GET /api/uploads` (list with `event_count` / `track_count` join). `GET /api/uploads/:id`. **`GET /api/uploads/:id/progress`** (added 2026-05-03 — single SQL aggregate returning `{video_id, duration_s, event_count, incidents_total, vlm_pending, vlm_done, vlm_skipped, vlm_error, vlm_enabled}`; powers the 5-stage upload-progress strip). `DELETE /api/uploads/:id` (cascade drops events). `GET /api/uploads/:id/events?group=tracks|none` (track-summary or raw rows). `GET /api/uploads/:id/incidents` (rule-detected + VLM-annotated incidents). `POST /api/uploads/:id/analyze` (run rule pack + VLM validator if `VLM_ENABLED=true`; returns `incidents_found`). `GET /api/uploads/:id/playback` (FileResponse off disk). `WS /ws/events` (live broadcast of mdx-raw entries). `GET /healthz` and `/health` for Docker healthcheck.

**Structured logging (`backend/app/logging_config.py`).** Configures the root logger with `LOG_LEVEL` and `LOG_FORMAT=text|json`. JSON Lines output is OpenTelemetry-envelope-friendly (`ts`, `level`/`severity_text`, `service`, `logger`, `msg`/`body`) with extra fields `video_id`, `run_id`, `request_id`, durations, counts, lag, and `exc_info`. Request-id middleware injects `x-request-id` on every response and propagates a `contextvars`-scoped request/run/video ID into all background tasks. Periodic consumer-health log from the event indexer (`event_indexer.consumer.health`). Per-frame detail is `DEBUG`-only.

**Vocabulary.** *Event* = raw detection (class + conf + bbox + frame). *Incident* = rule-detected behavioral pattern in `incidents` table. *Scenario* = the UI tab that renders incidents on the detail page.

---

## Frontend

**Stack:** Next.js 15.3 App Router, React 19, TypeScript, Tailwind v4 (CSS-based config via `@theme inline`), `radix-ui` umbrella, shadcn-style components (vendored under `src/components/ui/`), `lucide-react` icons. Fonts via `next/font/google`: Inter (body), Space Grotesk (display), JetBrains Mono.

**Pages.**

- `/uploads` — drag-drop uploader, prompt textarea, history table, suggestion chips, **5-stage progress strip driven by real backend signals (2026-05-03)**: `Uploading → Ingesting → Detecting rules → Validating → Done`. Powered by [`frontend/src/lib/use-upload-progress.ts`](frontend/src/lib/use-upload-progress.ts) custom hook — XHR upload-progress events, then polls `/api/uploads/:id/progress` every 1 s during ingest (with plateau detection: 3 consecutive identical `event_count` polls, armed after `min(15s, duration_s)`, hard cap at `duration_s + 5s`), then auto-fires `POST /api/uploads/:id/analyze` and polls every 2 s for VLM completion. Shows live sub-text under the active pill (`12 480 events`, `running…`, `12 / 57 validated`). Skip-to-done if `incidents_found === 0` or `vlm_enabled === false`. Red error pill on 5xx or `vlm_error > 0`. Click a row → detail page.
- `/uploads/[video_id]` — two-column layout. Left: HTML5 `<video>`, custom scrubber overlay with per-track detection bands (class-coloured) **plus an incident band layer** (severity-coloured, click-to-seek, tooltip with rule label + time range), prev/next track controls, single-line prompt recap pill. **Bbox debug overlay (2026-05-03)**: top-right `BBOXES OFF/ON` toggle on the player. When on, lazy-fetches `/api/uploads/:id/events?group=none` once, sorts by `t_seconds`, and overlays per-frame bounding boxes via rAF + binary search (`[currentTime - 1/(2*fps), +tol]`) with one box per `track_id` (closest in time wins) so loop duplicates collapse. Each box gets a deterministic golden-angle HSL colour from its `track_id`. Letterbox-aware (handles `object-fit: contain`). Right: tabbed Detected Events panel — **Scenarios is now the first/default tab (was Events)**, renders incident cards with VLM pill (`Confirmed`/`Rejected`/`Uncertain`/`Pending`/`Error`), expandable Why panel (reasoning + model + latency), and filter chips (`Confirmed` first/default, then `All`/`Rejected`/`Pending`). Tab trigger shows a count badge when incidents exist. Footers: Scenarios = "Rule-based detection & Vision Language Model validation"; Events = "Analysis Pipeline - Raw event detections". The `Events` tab lists tracks (class, max confidence, duration, first bbox) and click-seeks. Driver.js tour visits Scenarios → Events to match the new tab order.
- `/` — analytics overview rebuilt from the OpsVision dashboard reference: real Uploads-backed KPIs (upload count, indexed events, tracks, analyzed duration, latest upload, **rule-detected incidents**, **VLM-confirmed incidents**) plus polished "demo data" placeholders for analytics modules that don't have backing data yet.
- `/events`, `/settings` — placeholder routes; not blocking v1 demo.

**Design system.** OpsVision tokens (Synch Solutions orange `#ea6a22` accent on a cool slate `--ink-*` scale) live in `globals.css` under `@theme inline`. shadcn slot bindings (`--background`, `--card`, `--popover`, etc.) are defined alongside so primitives pick up OpsVision colours automatically.

**Theme toggle.** `src/components/theme-provider.tsx` reads/writes `aims-theme` in `localStorage` and toggles `dark` / `light` on `<html>`. `src/components/theme-toggle.tsx` is the Sun/Moon button in the header (top-right). A pre-hydration script in `src/app/layout.tsx` sets the class before paint to avoid FOUC, and `<html suppressHydrationWarning>` silences the SSR/CSR diff. Light tokens are aligned to the canonical OpsVision spec (`--surface-1: #ffffff`, `--bg: #f3f5f9`, soft borders) so the sidebar comes out white in light mode without a special case.

**shadcn-only directive.** All UI is built from the vendored shadcn primitives (`Button`, `Dialog`, `Badge`, `Card`, `Tabs`, `Tooltip`, `Skeleton`, `Sidebar`, etc.). One narrow exception: the scrubber DOM on the detail page is bespoke — Card padding/radius would break the row grid.

**Frontend logger (`frontend/src/lib/logger.ts`).** Same JSON Lines envelope as the backend, controlled by `NEXT_PUBLIC_LOG_LEVEL`, `NEXT_PUBLIC_LOG_FORMAT`, `NEXT_PUBLIC_SERVICE_NAME`, and `NEXT_PUBLIC_ENV`. Upload, WebSocket, and proxy `console.*` calls are routed through it.

**Layout shell.** `SidebarProvider` is `h-svh` (was `min-h-svh`), `SidebarInset` is `min-h-0 overflow-hidden`, the children wrapper has `min-h-0`. This caps page-level scroll to the viewport so the per-column flex chains in the detail page (events list overflow-auto inside the right column) actually contain, instead of pushing the whole page.

**Same-origin proxy.** `frontend/next.config.js` rewrites `/api/*` and `/ws/*` to `BACKEND_URL` (env, defaults to `http://backend:8080` for the compose network). `frontend/.env.local.example` documents the override for local `npm run dev`. `src/app/api/upload/route.ts` is a streaming multipart Route Handler — plain rewrites mangle multipart parsing.

---

## Dev tooling

`tools/synthetic_mdx_publisher.py` is an async script (`redis.asyncio` + `asyncpg` — both already in the backend image, lazy-imported so unit tests can pull the pure geometry helpers without those deps) that XADDs realistic detection frames into `mdx-raw` and sets `current_video_id` so the indexer routes them. Multi-track lifecycle (Car / Person / Bicycle, motion drift, spawn/despawn), 13-part DeepStream object format. `--ensure-upload` stubs an `uploads` row in Postgres so the detail page is reachable without going through the UI uploader. `--scenario collision` scripts a two-vehicle collision (overlapping bboxes + simultaneous velocity collapse + sustained stop, IOU peak ≈ 0.38) so the rule pack in `incident_worker.py` can be exercised end-to-end without GPU time. Runs inside the dev backend:

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-1 --ensure-upload --duration 20 --rate 200

# Exercise the rule pack:
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-collision --ensure-upload \
  --duration 20 --fps 30 --rate 500 --scenario collision
curl -X POST http://localhost:8080/api/uploads/synth-collision/analyze
curl http://localhost:8080/api/uploads/synth-collision/incidents
```

Backend unit tests (**14 tests, all passing as of 2026-05-03**):
- [`backend/tests/test_incident_worker.py`](backend/tests/test_incident_worker.py) — 6 tests: synthetic-collision firing, class-name normalization, signal computation, stale-row cleanup, plus two new tests for `_merge_overlapping` (brake-wave-collapses-to-densest and disjoint-clusters-stay-separate).
- [`backend/tests/test_uploads_progress.py`](backend/tests/test_uploads_progress.py) — 8 tests for `GET /api/uploads/:id/progress`: zeros, mid-pipeline, settled all-done, settled mixed skipped+error, 404 path, VLM env true/false/missing.

Run from repo root with `python3 -m unittest backend.tests.test_incident_worker backend.tests.test_uploads_progress -v`.

The progress-endpoint tests stub `app.db` and `fastapi` via `sys.modules` injection (`_stub_app_imports()` helper) because the test runner doesn't have FastAPI on the system Python — the real endpoint runs fine inside Docker. Use the same pattern when adding tests for other `uploads_list` endpoints.

---

## Known issues

- **DeepStream tracker breaks at impact (2026-05-03).** On `91_Country_Club.mp4`, the IOU tracker loses track 10 right at the moment of collision (track ends at t=15.3 s). The same physical car re-enters as track 18 at t=21.5 s — a 6-second tracker void where the rule pack has zero coverage of the immediate post-impact aftermath. Tracks (9, 18) overlap again at t=24.2-24.5 s but don't fire `vehicle_collision` because track 18 ends 1.3 s after the overlap, and the velocity-drop signal from the already-stationary track 9 is near zero. Track-break stitching is the proper upstream fix; out of scope for the demo. Document and move on.
- **Cosmos-Reason2-2B may be capacity-limited for subtle aftermath.** The (9, 10) collision flag at t=15.1 s on `91_Country_Club` was correctly extracted with the new tight clip window `[13.33s, 21.33s]` — clip contains the impact AND the visible debris aftermath — but Cosmos-2B rejected with 0.95 confidence saying "no collision evidence." Hypothesis: 2B can't read the visual cues. Next session swaps to **`nvcr.io/nim/nvidia/cosmos-reason2-8b:latest`** to test. Backend code stays unchanged — same `/v1/chat/completions` API, only the `vlm_model` field in DB rows would differ.
- **DeepStream `-r 2` loops the source.** The perception app re-plays the clip after EOS. Pre-2026-05-03 this corrupted the events table (~47× over-count on busy clips). Fixed by the indexer `ON CONFLICT DO NOTHING` + `events_dedup` unique index. Loop behaviour is preserved (the demo wants continuous detections in the live view); only the duplicate inserts are dropped. If you need to wipe and re-run a clip, `DELETE FROM events WHERE video_id=$1` and re-trigger via re-upload (or re-analyze, which only touches `incidents`).
- **NVStreamer 3.1.0 discovery bug (upstream, unresolved).** Files served by NVStreamer 3.1.0 lose codec/container metadata; `create_video_pipeline` rejects them; `POST /api/v1/file` returns 404. Workaround in place: `/api/uploads` writes `file:///data/videos/<filename>` directly to `current_stream_url.txt` and DeepStream reads via `uridecodebin`. NVStreamer is still up but unused — could be removed once 3.2.0 lands or the team accepts `file://` permanently.
- **`libnvds_redis_proto.so` presence is image-dependent.** The vss-rt-cv image ships Kafka as default; verify the Redis proto library is in `/opt/nvidia/deepstream/deepstream/lib/`. Comments in `deepstream/init/ds-start.sh` cover fallbacks (Kafka sidecar, file sink).
- **TRT engine cold compile is ~3.5 min** (3 min on A100, 3.5 on A6000). Persists in `data/models/` so it's a one-time cost per host. Phase 3 will pin the cache to a named volume so container rebuilds don't lose it.
- **Public access (Brev).** `https://ui-blxuttpxb.brevlab.com` (or `https://3000-blxuttpxb.brevlab.com` — same backend). Cloudflare Access auth one-shot; upload + playback + WS all flow through the same hostname via the Next.js proxy. (For the current Shadeform A100 host, use VS Code port forwarding on `3000` and `8080` — direct public access is blocked by their default security group.)
- **NGC notes.** The `ngc` CLI's signed-URL handler 403s on the redirect to `xfiles.ngc.nvidia.com`; bearer-token REST works (`curl -L -H "Authorization: Bearer $NGC_CLI_API_KEY" https://api.ngc.nvidia.com/v2/.../files/<name>`). Org `nvidia`, model `nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0`.
- **Repo hygiene.** `smoke-test.ipynb` reads `NGC_CLI_API_KEY` from env (older note about a hardcoded key is stale).
- **Runbook punch list (uncovered 2026-05-03 during fresh-VM rerun, not yet fixed):**
  - [`scripts/vm_setup.sh:141`](scripts/vm_setup.sh#L141) installs `ngc` CLI as a single binary (`sudo install -m 0755 "$tmp/ngc-cli/ngc" /usr/local/bin/ngc`). The CLI is a PyInstaller bundle that needs the whole directory tree; running `ngc --version` errors with `dlopen: /usr/local/bin/libpython3.9.so.1.0: cannot open shared object file`. Workaround used: install the whole directory to `/opt/ngc-cli/` and symlink the launcher. Doesn't block the runbook (Step 3 uses `curl + bearer token` because the CLI 403s on signed-URL redirects), but Step 1's `ngc --version` verify command fails as documented.
  - [`docs/v1/deploy/deploy.md:167`](docs/v1/deploy/deploy.md#L167) says: *"the canonical sample clip is already loaded — open `http://$HOST_IP:3000/uploads`, click it, and the pipeline starts."* Clicking a seeded row in the UI just navigates to `/uploads/[video_id]` — the seed flow inserts the DB row + copies the file but never sets `current_video_id` or restarts vss-rt-cv. Only `POST /api/upload` triggers the pipeline. Either the runbook should say "upload via drag-drop or curl" in Step 7, or add a "Start pipeline" button on the detail page that mimics the upload-side `current_video_id` set + container restart.

---

## Next steps

See [`docs/v1/plan.md`](docs/v1/plan.md) for the burn list. Landed: Phases 1 (rebrand), 2 (Uploads UI + detail page + Postgres + event indexer), 3 (healthchecks, `redis-commander` drop, `.env.example`), 5 (deploy runbook + Brev validation), 7 (rule-based incident detection), 8 (Cosmos-Reason2-2B VLM validation — items 25–30 shipped; spike #24 deferred to docs), 9 (structured logging + observability overlay), 10 (driver.js tour). The 2026-05-03 session also landed: 5-stage real-signal upload progress (see [`docs/v1/upload-progress.md`](docs/v1/upload-progress.md)), event-table dedup (schema unique index + indexer ON CONFLICT), bbox debug overlay, mass_stop interval-merge clustering, vehicle_collision rule loosening (OR co-stop, max stationary tail, iou_frames_min 3→2), per-rule VLM clip windows, VLM collision prompt rewrite for aftermath cues. None of these are committed yet — working tree has all the changes.

**Up next, in priority order:**

1. **Cosmos 8B model swap** — change [`docker-compose.yml:183`](./docker-compose.yml#L183) `image:` to `nvcr.io/nim/nvidia/cosmos-reason2-8b:latest`, `docker compose pull cosmos && docker compose up -d cosmos`, wait ~10 min for first-boot weight load (~30 GB image, ~16 GB BF16 in VRAM, fits comfortably on A100 80 GB), then `curl -X POST http://localhost:8080/api/uploads/91_Country_Club-1777844748/analyze` and check the (9, 10) verdict + reasoning. This is the immediate test for whether 2B was capacity-limited or if there's still a clip/prompt issue. Backend code stays unchanged.
2. **Commit the working tree.** Atomic commits, conventional style. Suggested split: `feat(upload-progress)`, `feat(events-dedup)`, `feat(rules)`, `feat(vlm)`, `feat(ui)`, `docs(current-state)`.
3. **Phase 6** — demo acceptance + `docs/demo-script.md`. Largely already validated by the 2026-05-03 cold-deploy; just needs the script written and screenshots captured.
4. **Punch-list cleanup** — fix `vm_setup.sh` ngc CLI install + correct runbook step 7 wording.
5. Phase 3 leftover — TRT engine cache as a named volume.
6. Phase 8 spike doc (#24) — informational only.

**Live system state (when machine comes back up):**

- Branch: `main`. Working tree has uncommitted changes across `backend/app/{event_indexer,incident_worker,vlm_validator,uploads_list}.py`, `backend/app/schema.sql`, `backend/tests/test_incident_worker.py`, `backend/tests/test_uploads_progress.py` (new), `frontend/src/app/uploads/page.tsx`, `frontend/src/app/uploads/[video_id]/page.tsx`, `frontend/src/lib/use-upload-progress.ts` (new), `frontend/src/lib/tour.ts`, plus `docs/v1/upload-progress.md` (new) and `CURRENT_STATE.md` (this file).
- DB has 5 uploads (incl. `91_Country_Club-1777844748` and `115_and_HVP-1777838948` which are the test clips) and ~39 k deduped events.
- `.env` has `VLM_ENABLED=true` and a real `NGC_CLI_API_KEY`. Cosmos-2B image is cached locally; `aims-cosmos-cache` named volume holds the weights.
- Bring the stack back up: `docker compose up -d` (no `--build` unless code changed).
- Frontend access: VS Code port forward on `3000` (UI) and `8080` (backend API). Public IP `154.54.100.247` is blocked by Shadeform's default security group.
