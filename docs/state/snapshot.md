# SSI AIMS — Current Snapshot

What is actually running on `main` right now. Truths here decay as code lands; refresh whenever a session changes the shape of any service. For dated session notes see [`log/`](log/). For the index see [`../../CURRENT_STATE.md`](../../CURRENT_STATE.md). For the roadmap see [`../v1/plan.md`](../v1/plan.md).

**Last refreshed:** 2026-05-05 (post collision-window fix + live VLM validation).

---

## What's running

Three compose files, all stable:

- **`docker-compose.yml` — prod.** Seven core services: `redis`, `postgres` (aims-postgres), `nvstreamer`, `sdr`, `vss-rt-cv` (DeepStream + GPU), `backend`, `frontend`. (`redis-commander` was dropped in Phase 3.) Plus `cosmos` (Cosmos-Reason2 NIM, GPU-bound) gated behind `profiles: [gpu]` as of 2026-05-04 — plain `docker compose up` does NOT bring it up; bring it up with `docker compose --profile gpu up -d` for the self-hosted VLM path. With `VLM_PROVIDER=openai` you skip the GPU profile entirely. NVStreamer is up but not in the perception path (see "Known issues"). Healthchecks land on `redis`, `postgres`, `backend`, and `vss-rt-cv`. `frontend` `depends_on` is `service_healthy`. Backend and frontend both receive structured log env vars (`LOG_LEVEL`, `LOG_FORMAT`, `SERVICE_NAME` / `NEXT_PUBLIC_*` equivalents).
- **`docker-compose.dev.yml` — dev (no GPU).** Three services: `redis`, `postgres`, `backend`. No NGC pull. Mounts `./tools` read-only at `/app/tools`. Log env vars injected (`LOG_LEVEL`, `LOG_FORMAT`, `SERVICE_NAME`, `ENV`).
- **`docker-compose.observability.yml` — optional overlay.** Adds Loki + Promtail + Grafana (port `3002`). Provisioned Loki datasource and **AIMS Support/Dev Logs** dashboard. Apply with: `docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d` (or the `dev.yml` variant).

The DeepStream side is unchanged from the POT — `metropolis_perception_app -m 7 -r 2` runs RT-DETR (TrafficCamNet) → IOU tracker → `nvmsgconv` → `nvmsgbroker` (`libnvds_redis_proto.so`) → `XADD mdx-raw`. Source pacing comes from `sync=1` on the sinks; ~7–8 events/sec at the source's native FPS. All four classes detected (car / bicycle / person / road_sign).

---

## Backend

**Stack:** FastAPI on Python 3.11-slim, `uvicorn` with `--limit-concurrency 10`, `asyncpg` pool, `redis[hiredis]>=5`, `aiofiles`, `python-multipart`, `openai>=1.50`. `ffmpeg` (for `ffprobe` and clip/frame extraction) is installed in the image.

**Persistence (Postgres 16-alpine).** [`backend/app/db.py`](../../backend/app/db.py) initialises the asyncpg pool at FastAPI lifespan start and runs [`backend/app/schema.sql`](../../backend/app/schema.sql). Three tables:

- `uploads` — `video_id` PK (per-run `{stem}-{timestamp}` so re-uploads append a new row), `original_filename`, `prompt`, `duration_s`, `width`, `height`, `fps`, `size_bytes`, `uploaded_at`.
- `events` — `id BIGSERIAL` PK, `video_id` FK with `ON DELETE CASCADE`, `track_id`, `frame_id`, `t_seconds`, `class`, `confidence`, `bbox_x1..y2`. Indexes on `(video_id, frame_id)` and `(video_id, track_id)`. Unique index `events_dedup` on `(video_id, frame_id, track_id)` — collapses duplicate detections from DeepStream's `-r 2` loop replays. The indexer pairs this with `INSERT ... ON CONFLICT DO NOTHING`.
- `incidents` — `id UUID` PK, `video_id` FK with `ON DELETE CASCADE`, `rule_id` (`vehicle_collision` / `ped_impact` / `stationary_vehicle` / `mass_stop`), `severity`, `confidence`, `t_start_s` / `t_end_s`, `frame_start` / `frame_end`, `track_ids INT[]`, `bbox_union JSONB`, `metadata JSONB`. Index on `(video_id, t_start_s)`; unique dedup index on `(video_id, rule_id, t_start_s, track_ids)`. `vlm_*` columns: `vlm_status`, `vlm_verdict`, `vlm_reasoning`, `vlm_confidence`, `vlm_model`, `vlm_clip_path`, `vlm_latency_ms`, `vlm_at`. Partial index on `vlm_status='pending'`. Re-analyze does a full `DELETE` + `INSERT` (not `ON CONFLICT`) — VLM verdicts reset to `pending` on every analyze; the validator re-queues automatically.

**Upload queue (`backend/app/upload_queue.py`).** In-process `asyncio.Queue` + serial worker spawned at FastAPI lifespan start. `POST /api/upload` enqueues; the worker pulls jobs serially and owns `current_video_id` / `current_stream_url.txt` / `vss-rt-cv` restart. Plateau detection: 3 consecutive identical `event_count` polls, armed after `min(15s, duration_s)`, hard cap `duration_s + 30s`. Caps depth at `UPLOAD_QUEUE_MAX_DEPTH` (default 10) → 503 with `{"error":"queue full"}`. Worker swallows exceptions so the queue keeps draining. **Workaround for the docker-socket-restart pattern; the proper fix (multi-source via `nvstreammux`) is logged as priority debt in [`../v1/plan.md`](../v1/plan.md).**

**Event indexer ([`backend/app/event_indexer.py`](../../backend/app/event_indexer.py)).** Background asyncio task spawned at lifespan start. Uses Redis `XREADGROUP` (group `indexer`, consumer `indexer-1`, MKSTREAM), parses pipe-delimited objects out of each `metadata` JSON envelope, looks up `current_video_id` from Redis to associate the frame with an upload, looks up `fps` from the `uploads` row (cached per-process) to compute `t_seconds = frame_id / fps`, and `executemany`s the rows. `INSERT ... ON CONFLICT (video_id, frame_id, track_id) DO NOTHING` so DeepStream's `-r 2` loop replays don't accumulate duplicate detections. Poison-pill safe: ack on success or on parse error, retry the outer loop on connection errors.

**Incident worker ([`backend/app/incident_worker.py`](../../backend/app/incident_worker.py)).** Pixel/track-space rule pack run on demand via `POST /api/uploads/:id/analyze`. Loads all events for the video, builds per-track signals (bisect-windowed velocity, velocity-drop ratio, stationary duration, bbox-aspect change) keyed on `(track_id, normalized_class)` so DeepStream's case-mixed class strings don't split tracks. Pairwise pass computes IOU overlap, centroid proximity, and co-stop. Four rules fire: `vehicle_collision` (sustained IOU + co-stop + stationary tail), `ped_impact` (centroid proximity + person track terminate-or-stop), `stationary_vehicle` (long stop with prior motion to filter parked cars), `mass_stop` (cluster of vehicles sharing a sudden velocity drop). On every analyze: full `DELETE FROM incidents WHERE video_id=$1` + insert fresh — VLM verdicts reset to `pending` and the validator re-queues.

**VLM validator ([`backend/app/vlm_validator.py`](../../backend/app/vlm_validator.py)).** Provider-agnostic. Picks up incidents with `vlm_status='pending'`, extracts a per-rule clip via ffmpeg into `${DATA_DIR}/incidents/<incident_id>.mp4` (debug artifact), calls `provider.validate(clip_path, rule_id)`, writes back verdict / reasoning / confidence / `provider.model_id`. `VLM_ENABLED=false` → marks all pending `'skipped'` in one UPDATE.

Per-rule clip windows ([`_clip_window`](../../backend/app/vlm_validator.py)):

- `vehicle_collision`: `[iou_peak_t - 2s, +18s]` (20 s, centred on contact frame; widened from 8 s on 2026-05-05 because the original window cut off before the visible aftermath/debris)
- `ped_impact`: `[t_start_s - 2s, +6s]` (8 s)
- `stationary_vehicle`: `[t_start_s, +8s]` (8 s)
- `mass_stop`: `[t_start_s - 1s, +4s]` (5 s)

**VLM providers ([`backend/app/vlm_providers/`](../../backend/app/vlm_providers/)).** Selected via `VLM_PROVIDER=cosmos|openai`. Module-isolated:

- `cosmos.py` — POSTs base64 mp4 to `${COSMOS_URL}/v1/chat/completions`. Model id from `COSMOS_MODEL`.
- `openai_provider.py` — extracts JPEG frames at `VLM_FRAME_FPS` (default 1) into a `TemporaryDirectory()`, sends them as `image_url` parts to `AsyncOpenAI().chat.completions.create` at `temperature=0.1`. Optional `OPENAI_BASE_URL` for any OAI-compatible endpoint (Vercel AI Gateway validated 2026-05-05 with `gpt-5.4-mini` and `alibaba/qwen3.5-flash`). The `response_format=json_object` flag was removed 2026-05-05 because the Vercel gateway rejects it as `invalid_request_error` for both models; the shared parser regex-extracts the verdict JSON from raw text and every prompt mandates JSON output, so json-mode is redundant.
- Shared `prompts.py` and `parsing.py` (verdict parser strips `<think>` blocks, falls back to `("uncertain", 0.5, ...)` on malformed output).

**Endpoints.** `POST /api/uploads` (multipart; saves file, ffprobes, inserts uploads row, enqueues. Response includes `queue_status` / `queue_position`; 503 above queue depth). `GET /api/uploads` (list with `event_count` / `track_count` join). `GET /api/uploads/:id`. `GET /api/uploads/:id/progress` (single SQL aggregate returning `{video_id, duration_s, event_count, incidents_total, vlm_pending, vlm_done, vlm_skipped, vlm_error, vlm_enabled, queue_status, queue_position}`). `DELETE /api/uploads/:id` (cascade drops events). `GET /api/uploads/:id/events?group=tracks|none`. `GET /api/uploads/:id/incidents`. `POST /api/uploads/:id/analyze` (rule pack + VLM if `VLM_ENABLED=true`; returns `incidents_found`). `GET /api/uploads/:id/playback` (FileResponse off disk). `WS /ws/events` (live broadcast of mdx-raw entries). `GET /healthz` and `/health` for Docker healthcheck. `GET /api/incidents/catalog`, `GET /api/incidents/config`, `PUT /api/incidents/config/:rule_id`.

**Structured logging ([`backend/app/logging_config.py`](../../backend/app/logging_config.py)).** Configures the root logger with `LOG_LEVEL` and `LOG_FORMAT=text|json`. JSON Lines output is OpenTelemetry-envelope-friendly (`ts`, `level`/`severity_text`, `service`, `logger`, `msg`/`body`) with extra fields `video_id`, `run_id`, `request_id`, durations, counts, lag, and `exc_info`. Request-id middleware injects `x-request-id` on every response and propagates a `contextvars`-scoped request/run/video ID into all background tasks. Periodic consumer-health log from the event indexer (`event_indexer.consumer.health`). Per-frame detail is `DEBUG`-only.

**Vocabulary.** *Event* = raw detection (class + conf + bbox + frame). *Incident* = rule-detected behavioral pattern in `incidents` table. *Scenario* = the UI tab that renders incidents on the detail page.

---

## Frontend

**Stack:** Next.js 15.3 App Router, React 19, TypeScript, Tailwind v4 (CSS-based config via `@theme inline`), `radix-ui` umbrella, shadcn-style components (vendored under `src/components/ui/`), `lucide-react` icons. Fonts via `next/font/google`: Inter (body), Space Grotesk (display), JetBrains Mono.

**Pages.**

- `/uploads` — drag-drop uploader, prompt textarea, history table, suggestion chips, **5-stage progress strip with conditional 6th leading "Queued" pill**: `[Queued →] Uploading → Ingesting → Detecting rules → Validating → Done`. Powered by [`frontend/src/lib/use-upload-progress.ts`](../../frontend/src/lib/use-upload-progress.ts) custom hook — XHR upload-progress events, then polls `/api/uploads/:id/progress` every 2 s while queued (slow-moving) or 1 s during ingest (plateau detection: 3 consecutive identical `event_count` polls, armed after `min(15s, duration_s)`, hard cap at `duration_s + 5s`), then auto-fires `POST /api/uploads/:id/analyze` and polls every 2 s for VLM completion. Queued sub-text: `"N ahead — waiting for DeepStream"` or `"next up"` at position 0. Other live sub-text (`12 480 events`, `running…`, `12 / 57 validated`). Skip-to-done if `incidents_found === 0` or `vlm_enabled === false`. Red error pill on 5xx, `vlm_error > 0`, or `POST /api/upload` 503 (`"Demo queue is full — try again in a moment."`). Click a row → detail page.
- `/uploads/[video_id]` — two-column layout. Left: HTML5 `<video>`, custom scrubber overlay with per-track detection bands (class-coloured) plus an incident band layer (severity-coloured, click-to-seek, tooltip with rule label + time range), prev/next track controls, single-line prompt recap pill. **Bbox debug overlay**: top-right `BBOXES OFF/ON` toggle on the player. When on, lazy-fetches `/api/uploads/:id/events?group=none` once, sorts by `t_seconds`, and overlays per-frame bounding boxes via rAF + binary search (`[currentTime - 1/(2*fps), +tol]`) with one box per `track_id` (closest in time wins) so loop duplicates collapse. Each box gets a deterministic golden-angle HSL colour from its `track_id`. Letterbox-aware (handles `object-fit: contain`). Right: tabbed Detected Events panel — Scenarios is the first/default tab, renders incident cards with VLM pill (`Confirmed`/`Rejected`/`Uncertain`/`Pending`/`Error`), expandable Why panel (reasoning + model + latency), and filter chips (`Confirmed` first/default, then `All`/`Rejected`/`Pending`). Tab trigger shows a count badge when incidents exist. Footers: Scenarios = "Rule-based detection & Vision Language Model validation"; Events = "Analysis Pipeline - Raw event detections". The `Events` tab lists tracks (class, max confidence, duration, first bbox) and click-seeks. Driver.js tour visits Scenarios → Events to match the tab order.
- `/` — analytics overview rebuilt from the OpsVision dashboard reference: real Uploads-backed KPIs (upload count, indexed events, tracks, analyzed duration, latest upload, **rule-detected incidents**, **VLM-confirmed incidents**) plus polished "demo data" placeholders for analytics modules that don't have backing data yet.
- `/events`, `/settings` — placeholder routes; not blocking v1 demo.

**Design system.** OpsVision tokens (Synch Solutions orange `#ea6a22` accent on a cool slate `--ink-*` scale) live in `globals.css` under `@theme inline`. shadcn slot bindings (`--background`, `--card`, `--popover`, etc.) are defined alongside so primitives pick up OpsVision colours automatically.

**Theme toggle.** `src/components/theme-provider.tsx` reads/writes `aims-theme` in `localStorage` and toggles `dark` / `light` on `<html>`. `src/components/theme-toggle.tsx` is the Sun/Moon button in the header (top-right). A pre-hydration script in `src/app/layout.tsx` sets the class before paint to avoid FOUC, and `<html suppressHydrationWarning>` silences the SSR/CSR diff. Light tokens are aligned to the canonical OpsVision spec (`--surface-1: #ffffff`, `--bg: #f3f5f9`, soft borders) so the sidebar comes out white in light mode without a special case.

**shadcn-only directive.** All UI is built from the vendored shadcn primitives (`Button`, `Dialog`, `Badge`, `Card`, `Tabs`, `Tooltip`, `Skeleton`, `Sidebar`, etc.). One narrow exception: the scrubber DOM on the detail page is bespoke — Card padding/radius would break the row grid.

**Frontend logger ([`frontend/src/lib/logger.ts`](../../frontend/src/lib/logger.ts)).** Same JSON Lines envelope as the backend, controlled by `NEXT_PUBLIC_LOG_LEVEL`, `NEXT_PUBLIC_LOG_FORMAT`, `NEXT_PUBLIC_SERVICE_NAME`, and `NEXT_PUBLIC_ENV`. Upload, WebSocket, and proxy `console.*` calls are routed through it.

**Layout shell.** `SidebarProvider` is `h-svh` (was `min-h-svh`), `SidebarInset` is `min-h-0 overflow-hidden`, the children wrapper has `min-h-0`. This caps page-level scroll to the viewport so the per-column flex chains in the detail page (events list overflow-auto inside the right column) actually contain, instead of pushing the whole page.

**Same-origin proxy.** `frontend/next.config.js` rewrites `/api/*` and `/ws/*` to `BACKEND_URL` (env, defaults to `http://backend:8080` for the compose network). `frontend/.env.local.example` documents the override for local `npm run dev`. `src/app/api/upload/route.ts` is a streaming multipart Route Handler — plain rewrites mangle multipart parsing.

---

## Dev tooling

[`tools/synthetic_mdx_publisher.py`](../../tools/synthetic_mdx_publisher.py) is an async script (`redis.asyncio` + `asyncpg` — both already in the backend image, lazy-imported so unit tests can pull the pure geometry helpers without those deps) that XADDs realistic detection frames into `mdx-raw` and sets `current_video_id` so the indexer routes them. Multi-track lifecycle (Car / Person / Bicycle, motion drift, spawn/despawn), 13-part DeepStream object format. `--ensure-upload` stubs an `uploads` row in Postgres so the detail page is reachable without going through the UI uploader. `--scenario collision` scripts a two-vehicle collision (overlapping bboxes + simultaneous velocity collapse + sustained stop, IOU peak ≈ 0.38) so the rule pack can be exercised end-to-end without GPU time. Runs inside the dev backend:

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

Backend unit tests (**31 tests, all passing as of 2026-05-04**):

- [`backend/tests/test_incident_worker.py`](../../backend/tests/test_incident_worker.py) — 6 tests
- [`backend/tests/test_uploads_progress.py`](../../backend/tests/test_uploads_progress.py) — 8 tests (`/api/uploads/:id/progress` endpoint)
- [`backend/tests/test_upload_queue.py`](../../backend/tests/test_upload_queue.py) — 7 tests (queue lifecycle, full-queue, serial worker, exception swallow)
- [`backend/tests/test_vlm_providers.py`](../../backend/tests/test_vlm_providers.py) — 10 tests (selector, env validation, OpenAI parsing, module isolation)

Run from repo root:

```bash
python3 -m unittest backend.tests.test_incident_worker backend.tests.test_uploads_progress backend.tests.test_upload_queue backend.tests.test_vlm_providers -v
```

The progress / queue / provider tests stub `app.db`, `fastapi`, and the `openai` SDK via `sys.modules` injection (`_stub_app_imports()` helper) because the test runner doesn't have those deps on the system Python — the real code runs fine inside Docker. Use the same pattern when adding tests for other modules with heavy import deps.

---

## Known issues

- **DeepStream tracker breaks at impact.** On `91_Country_Club.mp4`, the IOU tracker loses track 10 right at the moment of collision (track ends at t=15.3 s). The same physical car re-enters as track 18 at t=21.5 s — a 6-second tracker void where the rule pack has zero coverage of the immediate post-impact aftermath. Tracks (9, 18) overlap again at t=24.2-24.5 s but don't fire `vehicle_collision` because track 18 ends 1.3 s after the overlap, and the velocity-drop signal from the already-stationary track 9 is near zero. Track-break stitching is the proper upstream fix; out of scope for the demo. Document and move on.
- ~~Cosmos-Reason2-2B may be capacity-limited for subtle aftermath.~~ **Resolved 2026-05-05** — was clip-window framing, not model capacity. The original 8 s `vehicle_collision` window (`[iou_peak_t - 2, +6]`) ended at t≈21 s — exactly where the visible debris on `91_Country_Club` *began*. Cosmos-2B (yesterday), `gpt-5.4-mini`, and `alibaba/qwen3.5-flash` all rejected the 8 s clip at 0.93-0.95 confidence with near-identical "no debris" reasoning; both providers tested today flip to confirmed at 0.95-0.98 on the widened 20 s window, explicitly citing the debris. Window widened in commit `1fe6291`. See [log/2026-05-05-collision-window-and-vlm-live-validation.md](log/2026-05-05-collision-window-and-vlm-live-validation.md).
- **DeepStream `-r 2` loops the source.** The perception app re-plays the clip after EOS. Pre-2026-05-03 this corrupted the events table (~47× over-count on busy clips). Fixed by the indexer `ON CONFLICT DO NOTHING` + `events_dedup` unique index. Loop behaviour is preserved (the demo wants continuous detections in the live view); only the duplicate inserts are dropped. If you need to wipe and re-run a clip, `DELETE FROM events WHERE video_id=$1` and re-trigger via re-upload (or re-analyze, which only touches `incidents`).
- **NVStreamer 3.1.0 discovery bug (upstream, unresolved).** Files served by NVStreamer 3.1.0 lose codec/container metadata; `create_video_pipeline` rejects them; `POST /api/v1/file` returns 404. Workaround in place: `/api/uploads` writes `file:///data/videos/<filename>` directly to `current_stream_url.txt` and DeepStream reads via `uridecodebin`. NVStreamer is still up but unused — could be removed once 3.2.0 lands or the team accepts `file://` permanently.
- **`libnvds_redis_proto.so` presence is image-dependent.** The vss-rt-cv image ships Kafka as default; verify the Redis proto library is in `/opt/nvidia/deepstream/deepstream/lib/`. Comments in `deepstream/init/ds-start.sh` cover fallbacks (Kafka sidecar, file sink).
- **TRT engine cold compile is ~3.5 min** (3 min on A100, 3.5 on A6000). Persists in `data/models/` so it's a one-time cost per host. Phase 3 will pin the cache to a named volume so container rebuilds don't lose it.
- **Public access (Brev).** `https://ui-blxuttpxb.brevlab.com` (or `https://3000-blxuttpxb.brevlab.com` — same backend). Cloudflare Access auth one-shot; upload + playback + WS all flow through the same hostname via the Next.js proxy. (For Shadeform A100 hosts, use VS Code port forwarding on `3000` and `8080` — direct public access is blocked by their default security group.)
- **NGC notes.** The `ngc` CLI's signed-URL handler 403s on the redirect to `xfiles.ngc.nvidia.com`; bearer-token REST works (`curl -L -H "Authorization: Bearer $NGC_CLI_API_KEY" https://api.ngc.nvidia.com/v2/.../files/<name>`). Org `nvidia`, model `nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0`.
- **Repo hygiene.** `smoke-test.ipynb` reads `NGC_CLI_API_KEY` from env (older note about a hardcoded key is stale).
- **Runbook punch list (uncovered 2026-05-03 during fresh-VM rerun, not yet fixed):**
  - [`scripts/vm_setup.sh:141`](../../scripts/vm_setup.sh#L141) installs `ngc` CLI as a single binary. The CLI is a PyInstaller bundle that needs the whole directory tree; running `ngc --version` errors with `dlopen: /usr/local/bin/libpython3.9.so.1.0: cannot open shared object file`. Workaround used: install the whole directory to `/opt/ngc-cli/` and symlink the launcher.
  - [`docs/v1/deploy/deploy.md`](../v1/deploy/deploy.md) seed-clip wording: clicking a seeded row in the UI doesn't trigger the pipeline. The seed flow inserts the DB row + copies the file but never sets `current_video_id` or restarts vss-rt-cv. Only `POST /api/upload` triggers it. Either rewrite Step 7 to say "upload via drag-drop or curl" or add a "Start pipeline" button on the detail page.

---

## Architectural debt (priority)

- 🚨 **Replace docker-socket container-restart with multi-source DeepStream pipeline.** Currently every upload restarts `vss-rt-cv` via `/var/run/docker.sock` — single-tenant, ~20–30 s wall cost per restart, exposes the host docker socket inside the backend container. The job queue serializes this safely but doesn't fix the architecture. Proper fix: tag `mdx-raw` events with `video_id` at the source (`nvmsgconv` schema change), drop the `current_video_id` global, run a long-lived DeepStream pipeline with sources added/removed at runtime via `nvstreammux`. Estimated 2–3 days. Logged in [`../v1/plan.md`](../v1/plan.md) under "High-priority architectural debt."

---

## Next steps

See [`../v1/plan.md`](../v1/plan.md) for the full burn list. Immediate priorities:

1. **Provider badge in the Why panel** — frontend chip distinguishing Cosmos vs OpenAI verdicts in the incidents UI. Today's two-provider story is now real demo content; surfacing `vlm_model` provenance is a small visual win. Frontend-only, shadcn `Badge`, ~1 hour. Listed in [`../v1/plan.md`](../v1/plan.md).
2. **Phase 6** — demo acceptance + `docs/demo-script.md`. Stack validated end-to-end on Brev A6000 + Shadeform A100, and as of 2026-05-05 the (9, 10) collision now confirms cleanly via either VLM provider. Just needs the script written and screenshots captured.
3. **Punch-list cleanup** — fix `vm_setup.sh` ngc CLI install + correct runbook step 7 wording (seeded clips don't auto-start the pipeline; only `POST /api/upload` does).
4. **Phase 3 leftover** — TRT engine cache as a named volume.
5. **Architectural debt** — multi-source DeepStream (above).
