# SSI AIMS — Current State

Snapshot of what is actually running on `main`. For the roadmap and burn list see [`./V1_PLAN.md`](./V1_PLAN.md). For onboarding see [`README.md`](./README.md). For DeepStream-only reference material from the POT era see [`FUTURE_STATE_POT_ARCHIVED.md`](./FUTURE_STATE_POT_ARCHIVED.md).

---

## End-to-end validation

**2026-04-30 — pipeline ran end-to-end on a fresh Brev VM (A6000 48 GB, driver 580).** Uploaded `115_and_HVP.mp4` (1280×720, 15 fps, 148.8 s) via `POST /api/upload`. DeepStream → Redis `mdx-raw` → indexer → Postgres `events` flowed cleanly: 16,526 detections across 70 tracks, all four classes (car 10,891 / road_sign 2,386 / person 2,204 / bicycle 1,045), `max(t_seconds)=148.67` matching clip duration. `GET /api/uploads` and `GET /api/uploads/:id/events?group=tracks` returned correct shape. Cold-deploy gotchas (model dir perms, NGC ONNX pre-stage, frontend `.dockerignore`, postgres startup race, SDR DNS flake) catalogued in [`docs/gotchas.md`](./docs/gotchas.md).

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
- `events` — `id BIGSERIAL` PK, `video_id` FK with `ON DELETE CASCADE`, `track_id`, `frame_id`, `t_seconds`, `class`, `confidence`, `bbox_x1..y2`. Indexes on `(video_id, frame_id)` and `(video_id, track_id)`.
- `incidents` — `id UUID` PK, `video_id` FK with `ON DELETE CASCADE`, `rule_id` (`vehicle_collision` / `ped_impact` / `stationary_vehicle` / `mass_stop`), `severity`, `confidence`, `t_start_s` / `t_end_s`, `frame_start` / `frame_end`, `track_ids INT[]`, `bbox_union JSONB`, `metadata JSONB`. Index on `(video_id, t_start_s)`; unique dedup index on `(video_id, rule_id, t_start_s, track_ids)`. Phase 8 added `vlm_*` columns via `ALTER TABLE IF NOT EXISTS`: `vlm_status`, `vlm_verdict`, `vlm_reasoning`, `vlm_confidence`, `vlm_model`, `vlm_clip_path`, `vlm_latency_ms`, `vlm_at`. Partial index on `vlm_status='pending'`.

**Event indexer (`backend/app/event_indexer.py`).** Background asyncio task spawned at lifespan start. Uses Redis `XREADGROUP` (group `indexer`, consumer `indexer-1`, MKSTREAM), parses the pipe-delimited objects out of each `metadata` JSON envelope, looks up `current_video_id` from Redis to associate the frame with an upload, looks up `fps` from the `uploads` row (cached per-process) to compute `t_seconds = frame_id / fps`, and `executemany`s the rows. Poison-pill safe: ack on success or on parse error, retry the outer loop on connection errors.

**Incident worker (`backend/app/incident_worker.py`).** Pixel/track-space rule pack run on demand via `POST /api/uploads/:id/analyze`. Loads all events for the video, builds per-track signals (bisect-windowed velocity, velocity-drop ratio, stationary duration, bbox-aspect change) keyed on `(track_id, normalized_class)` so DeepStream's case-mixed class strings don't split tracks. Pairwise pass computes IOU overlap, centroid proximity, and co-stop. Four rules fire: `vehicle_collision` (sustained IOU + co-stop + stationary tail), `ped_impact` (centroid proximity + person track terminate-or-stop), `stationary_vehicle` (long stop with prior motion to filter parked cars), `mass_stop` (cluster of vehicles sharing a sudden velocity drop). Idempotent ON CONFLICT upsert; re-analyze refines confidence/end time without wiping rows so Phase 8 VLM verdicts will survive.

**Endpoints.** `POST /api/uploads` (multipart; saves file, ffprobes, inserts uploads row, sets `current_video_id`, restarts vss-rt-cv via Docker socket). `GET /api/uploads` (list with `event_count` / `track_count` join). `GET /api/uploads/:id`. `DELETE /api/uploads/:id` (cascade drops events). `GET /api/uploads/:id/events?group=tracks|none` (track-summary or raw rows). `GET /api/uploads/:id/incidents` (rule-detected + VLM-annotated incidents). `POST /api/uploads/:id/analyze` (run rule pack + VLM validator if `VLM_ENABLED=true`; returns `incidents_found`). `GET /api/uploads/:id/playback` (FileResponse off disk). `WS /ws/events` (live broadcast of mdx-raw entries). `GET /healthz` and `/health` for Docker healthcheck.

**Structured logging (`backend/app/logging_config.py`).** Configures the root logger with `LOG_LEVEL` and `LOG_FORMAT=text|json`. JSON Lines output is OpenTelemetry-envelope-friendly (`ts`, `level`/`severity_text`, `service`, `logger`, `msg`/`body`) with extra fields `video_id`, `run_id`, `request_id`, durations, counts, lag, and `exc_info`. Request-id middleware injects `x-request-id` on every response and propagates a `contextvars`-scoped request/run/video ID into all background tasks. Periodic consumer-health log from the event indexer (`event_indexer.consumer.health`). Per-frame detail is `DEBUG`-only.

**Vocabulary.** *Event* = raw detection (class + conf + bbox + frame). *Incident* = rule-detected behavioral pattern in `incidents` table. *Scenario* = the UI tab that renders incidents on the detail page.

---

## Frontend

**Stack:** Next.js 15.3 App Router, React 19, TypeScript, Tailwind v4 (CSS-based config via `@theme inline`), `radix-ui` umbrella, shadcn-style components (vendored under `src/components/ui/`), `lucide-react` icons. Fonts via `next/font/google`: Inter (body), Space Grotesk (display), JetBrains Mono.

**Pages.**

- `/uploads` — drag-drop uploader, prompt textarea, history table, suggestion chips, 4-stage progress strip. Click a row → detail page.
- `/uploads/[video_id]` — two-column layout. Left: HTML5 `<video>`, custom scrubber overlay with per-track detection bands (class-coloured) **plus an incident band layer** (severity-coloured, click-to-seek, tooltip with rule label + time range), prev/next track controls, single-line prompt recap pill. Right: tabbed Detected Events panel — Events tab lists tracks (class, max confidence, duration, first bbox) and click-seeks; **Scenarios tab is live** and renders incident cards with VLM pill (`Confirmed`/`Rejected`/`Uncertain`/`Pending`/`Error`), expandable Why panel (reasoning + model + latency), and filter chips (All/Confirmed/Rejected/Pending). Tab trigger shows a count badge when incidents exist.
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

Backend unit tests (`backend/tests/test_incident_worker.py`, 4 tests) verify rule firing, class-name normalization, signal computation, and stale-row cleanup. Run with `python -m unittest backend.tests.test_incident_worker` from the repo root.

---

## Known issues

- **NVStreamer 3.1.0 discovery bug (upstream, unresolved).** Files served by NVStreamer 3.1.0 lose codec/container metadata; `create_video_pipeline` rejects them; `POST /api/v1/file` returns 404. Workaround in place: `/api/uploads` writes `file:///data/videos/<filename>` directly to `current_stream_url.txt` and DeepStream reads via `uridecodebin`. NVStreamer is still up but unused — could be removed once 3.2.0 lands or the team accepts `file://` permanently.
- **`libnvds_redis_proto.so` presence is image-dependent.** The vss-rt-cv image ships Kafka as default; verify the Redis proto library is in `/opt/nvidia/deepstream/deepstream/lib/`. Comments in `deepstream/init/ds-start.sh` cover fallbacks (Kafka sidecar, file sink).
- **TRT engine cold compile is ~3.5 min.** Persists in `data/models/` so it's a one-time cost per host. Phase 3 will pin the cache to a named volume so container rebuilds don't lose it.
- **Public access (Brev).** `https://ui-blxuttpxb.brevlab.com` (or `https://3000-blxuttpxb.brevlab.com` — same backend). Cloudflare Access auth one-shot; upload + playback + WS all flow through the same hostname via the Next.js proxy.
- **NGC notes.** The `ngc` CLI's signed-URL handler 403s on the redirect to `xfiles.ngc.nvidia.com`; bearer-token REST works (`curl -L -H "Authorization: Bearer $NGC_CLI_API_KEY" https://api.ngc.nvidia.com/v2/.../files/<name>`). Org `nvidia`, model `nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0`.
- **Repo hygiene.** `smoke-test.ipynb` reads `NGC_CLI_API_KEY` from env (older note about a hardcoded key is stale).

---

## Next steps

See [`V1_PLAN.md`](V1_PLAN.md) for the burn list. Landed: Phases 1 (rebrand), 2 (Uploads UI + detail page + Postgres + event indexer), 3 (healthchecks, `redis-commander` drop, `.env.example`), 5 (deploy runbook + Brev validation), 7 (rule-based incident detection), 8 (Cosmos-Reason2-2B VLM validation — items 25–30 shipped; spike #24 deferred to docs), 9 (structured logging + observability overlay). Up next, in priority order:

1. **Phase 4** — repo rename: done. Dir is now `aims/`; README/compose/planning cross-refs updated.
2. **Phase 6** — demo acceptance: run 8 acceptance criteria on the live VM, capture screenshots, write `docs/demo-script.md`.
3. Remaining Phase 3 item — TRT engine cache as a named volume (drops the `chmod -R 777 data/models` step).
4. Phase 8 spike doc (#24) — `docs/cosmos-spike.md` with endpoint contract / VRAM / cold-start / Ampere compat (informational; the code already ships with `VLM_ENABLED=false` as the safe default).

Branch: `main`. Recent commits: `4219fd0` (incidents config page), `8a5fa13` (incident catalog + `/api/incidents/catalog`), `7e95b2a` (mass_stop threshold tuning), `155e284` (route headers into layout), `0e10856` (Phase 8 docs), `203f769` (Phase 8 VLM items 25–29), `3c7cd68` (Phase 3 hardening). Working tree: Phase 9 observability (logging, Loki/Grafana overlay, frontend logger) — not yet committed.
