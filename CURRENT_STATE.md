# SSI AIMS — Current State

Snapshot of what is actually running on `feat/aims-rebrand` after the "POT-becomes-app" pivot. For the roadmap and burn list see [`../V1_PLAN.md`](../V1_PLAN.md). For onboarding see [`README.md`](./README.md). For DeepStream-only reference material from the POT era see [`FUTURE_STATE_POT_ARCHIVED.md`](./FUTURE_STATE_POT_ARCHIVED.md).

---

## What's running

Two compose stacks, both stable:

- **`docker-compose.yml` — prod.** Eight services: `redis`, `postgres` (aims-postgres), `nvstreamer`, `sdr`, `vss-rt-cv` (DeepStream + GPU), `backend`, `frontend`, `redis-commander`. NVStreamer is up but not in the perception path (see "Known issues"). Phase 3 will drop redis-commander and add healthchecks.
- **`docker-compose.dev.yml` — dev (no GPU).** Three services: `redis`, `postgres`, `backend`. No NGC pull. Mounts `./tools` read-only at `/app/tools` so the synthetic publisher runs inside the container.

The DeepStream side is unchanged from the POT — `metropolis_perception_app -m 7 -r 2` runs RT-DETR (TrafficCamNet) → IOU tracker → `nvmsgconv` → `nvmsgbroker` (`libnvds_redis_proto.so`) → `XADD mdx-raw`. Source pacing comes from `sync=1` on the sinks; ~7–8 events/sec at the source's native FPS. All four classes detected (car / bicycle / person / road_sign).

---

## Backend

**Stack:** FastAPI on Python 3.11-slim, `uvicorn` with `--limit-concurrency 10`, `asyncpg` pool, `redis[hiredis]>=5`, `aiofiles`, `python-multipart`. `ffmpeg` (for `ffprobe`) is installed in the image so the upload handler can read duration / resolution / fps.

**Persistence (Postgres 16-alpine).** `backend/app/db.py` initialises the asyncpg pool at FastAPI lifespan start and runs `backend/app/schema.sql`. Two tables:

- `uploads` — `video_id` PK (per-run `{stem}-{timestamp}` so re-uploads append a new row), `original_filename`, `prompt`, `duration_s`, `width`, `height`, `fps`, `size_bytes`, `uploaded_at`.
- `events` — `id BIGSERIAL` PK, `video_id` FK with `ON DELETE CASCADE`, `track_id`, `frame_id`, `t_seconds`, `class`, `confidence`, `bbox_x1..y2`. Indexes on `(video_id, frame_id)` and `(video_id, track_id)`.

**Event indexer (`backend/app/event_indexer.py`).** Background asyncio task spawned at lifespan start. Uses Redis `XREADGROUP` (group `indexer`, consumer `indexer-1`, MKSTREAM), parses the pipe-delimited objects out of each `metadata` JSON envelope, looks up `current_video_id` from Redis to associate the frame with an upload, looks up `fps` from the `uploads` row (cached per-process) to compute `t_seconds = frame_id / fps`, and `executemany`s the rows. Poison-pill safe: ack on success or on parse error, retry the outer loop on connection errors.

**Endpoints.** `POST /api/uploads` (multipart; saves file, ffprobes, inserts uploads row, sets `current_video_id`, restarts vss-rt-cv via Docker socket). `GET /api/uploads` (list with `event_count` / `track_count` join). `GET /api/uploads/:id`. `DELETE /api/uploads/:id` (cascade drops events). `GET /api/uploads/:id/events?group=tracks|none` (track-summary or raw rows). `GET /api/uploads/:id/playback` (FileResponse off disk, content-type from extension stored on the row). `WS /ws/events` (live broadcast of mdx-raw entries for the dashboard overlay).

**Vocabulary:** *event* = raw detection (class + conf + bbox + frame). *Scenario* = semantic interpretation of events over time (out of scope; v1.5).

---

## Frontend

**Stack:** Next.js 15.3 App Router, React 19, TypeScript, Tailwind v4 (CSS-based config via `@theme inline`), `radix-ui` umbrella, shadcn-style components (vendored under `src/components/ui/`), `lucide-react` icons. Fonts via `next/font/google`: Inter (body), Space Grotesk (display), JetBrains Mono.

**Pages.**

- `/uploads` — drag-drop uploader, prompt textarea, history table, suggestion chips, 4-stage progress strip. Click a row → detail page.
- `/uploads/[video_id]` — two-column layout. Left: HTML5 `<video>`, custom scrubber overlay with per-track detection bands (class-coloured), prev/next track controls, single-line prompt recap pill. Right: tabbed Detected Events panel — Events tab lists tracks (class, max confidence, duration, first bbox) and click-seeks; Scenarios tab is disabled and labelled deferred to v1.5.
- `/` (dashboard), `/events`, `/settings` — placeholder routes; dashboard palette pass is next on the burn list.

**Design system.** OpsVision tokens (Synch Solutions orange `#ea6a22` accent on a cool slate `--ink-*` scale) live in `globals.css` under `@theme inline`. shadcn slot bindings (`--background`, `--card`, `--popover`, etc.) are defined alongside so primitives pick up OpsVision colours automatically.

**Theme toggle.** `src/components/theme-provider.tsx` reads/writes `aims-theme` in `localStorage` and toggles `dark` / `light` on `<html>`. `src/components/theme-toggle.tsx` is the Sun/Moon button in the header (top-right). A pre-hydration script in `src/app/layout.tsx` sets the class before paint to avoid FOUC, and `<html suppressHydrationWarning>` silences the SSR/CSR diff. Light tokens are aligned to the canonical OpsVision spec (`--surface-1: #ffffff`, `--bg: #f3f5f9`, soft borders) so the sidebar comes out white in light mode without a special case.

**shadcn-only directive.** All UI is built from the vendored shadcn primitives (`Button`, `Dialog`, `Badge`, `Card`, `Tabs`, `Tooltip`, `Skeleton`, `Sidebar`, etc.). One narrow exception: the scrubber DOM on the detail page is bespoke — Card padding/radius would break the row grid.

**Layout shell.** `SidebarProvider` is `h-svh` (was `min-h-svh`), `SidebarInset` is `min-h-0 overflow-hidden`, the children wrapper has `min-h-0`. This caps page-level scroll to the viewport so the per-column flex chains in the detail page (events list overflow-auto inside the right column) actually contain, instead of pushing the whole page.

**Same-origin proxy.** `frontend/next.config.js` rewrites `/api/*` and `/ws/*` to `BACKEND_URL` (env, defaults to `http://backend:8080` for the compose network). `frontend/.env.local.example` documents the override for local `npm run dev`. `src/app/api/upload/route.ts` is a streaming multipart Route Handler — plain rewrites mangle multipart parsing.

---

## Dev tooling

`tools/synthetic_mdx_publisher.py` is an async script (`redis.asyncio` + `asyncpg` — both already in the backend image) that XADDs realistic detection frames into `mdx-raw` and sets `current_video_id` so the indexer routes them. Multi-track lifecycle (Car / Person / Bicycle, motion drift, spawn/despawn), 13-part DeepStream object format. `--ensure-upload` stubs an `uploads` row in Postgres so the detail page is reachable without going through the UI uploader. Runs inside the dev backend:

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-1 --ensure-upload --duration 20 --rate 200
```

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

See ['V1_PLAN.md`](V1_PLAN.md) for the burn list. Phases 1 (rebrand) and 2 (Uploads UI + detail page + Postgres + event indexer) are landed. Burn list item #1 (synthetic publisher) is landed. Up next, in priority order:

1. Dashboard (`/`) OpsVision palette pass.
2. Phase 3 backend hardening: `file-loop=0` in `deepstream/config/perception-config.txt`, healthchecks across services, TRT engine cache as a named volume, drop `redis-commander`, refresh `.env.example`.
3. Phase 4 repo rename: `git mv vss-rt-cv-pot aims`.
4. Phase 5 deploy runbook (`aims/docs/deploy.md`) + cold deploy on a fresh Brev VM.
5. Phase 6 demo acceptance.

Branch: `feat/aims-rebrand`. Two commits ahead of origin (push pending auth setup): `a5fc5fe` (synthetic publisher) and `5d3a742` (viewport-bounded layout + theme toggle).
