# SSI AIMS — AI Monitoring System

> Repo dir is `aims/` (renamed from `vss-rt-cv-pot/` in Phase 4 of the v1 ship plan).

Real-time computer vision monitoring. Upload a video, the DeepStream perception pipeline (RT-DETR / TrafficCamNet) runs detection + tracking, raw events stream to Redis, an indexer drains them into Postgres, and the Next.js UI lets you scrub the timeline and inspect per-track detections.

The original POT is intact under the hood. What's new is that POT is the app now — no integration target, no auth — wrapped in an OpsVision-styled UI with persistent uploads/events.

**Target host:** Brev RTX PRO 6000 BW (or any Docker + NVIDIA GPU host).

---

## Overview

Two compose stacks:

- `docker-compose.yml` — full prod stack (redis, postgres, nvstreamer, sdr, vss-rt-cv, backend, frontend, redis-commander).
- `docker-compose.dev.yml` — backend-only stack (redis + postgres + backend). No GPU, no NGC pull. Use for frontend / API iteration.

Two ways to feed events:

- Real perception via the GPU stack (uploads land on disk, NVStreamer is bypassed via `file://`, DeepStream emits to `mdx-raw`).
- `tools/synthetic_mdx_publisher.py` — XADDs realistic detection frames straight to Redis. Lets you exercise the indexer, scrubber, and detail page without a GPU.

---

## Prerequisites (prod stack)

- Docker + Docker Compose v2
- NVIDIA Container Toolkit (`nvidia-smi` works)
- NGC CLI authenticated (`ngc config set`)
- NGC API key with access to `nvcr.io/nvidia/vss-core/*`
- Docker logged in to NGC:

```bash
echo $NGC_CLI_API_KEY | docker login nvcr.io -u '$oauthtoken' --password-stdin
```

---

## Quick start (prod)

```bash
git clone <repo-url> aims
cd aims
cp .env.example .env       # fill NGC_CLI_API_KEY, HOST_IP, DATA_DIR
chmod +x deepstream/init/ds-start.sh
```

`.env` essentials:

```bash
NGC_CLI_API_KEY=<your-api-key>
HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
DATA_DIR=./data

# VLM provider — pick one:
#   cosmos  → local NIM container (GPU required, no per-call cost)  [default]
#   openai  → OpenAI API or any OAI-compatible endpoint
VLM_PROVIDER=cosmos
VLM_ENABLED=false       # set true to actually run validation
# OPENAI_API_KEY=...    # required when VLM_PROVIDER=openai
# OPENAI_MODEL=gpt-5.4-mini
```

The `cosmos` service is gated behind `profiles: [gpu]` — plain `docker compose up` skips
the 30 GB NIM image. Bring it up with `docker compose --profile gpu up -d` for the
self-hosted VLM path; omit the profile if you're using `VLM_PROVIDER=openai`.

Get sample videos:

```bash
ngc registry resource download-version nvidia/vss-developer/dev-profile-sample-data:3.0.0
mkdir -p data/videos
tar -xf dev-profile-sample-data_v3.0.0/dev-profile-sample-data.tar.gz -C data/videos/
rm -rf dev-profile-sample-data_v3.0.0
```

Bring it up:

```bash
docker compose up -d
docker compose logs -f vss-rt-cv   # wait for "Starting DeepStream perception pipeline..."
```

First run takes 2–5 minutes — the TRT engine is built once and cached in `data/models/`.

---

## Dev stack (no GPU)

For frontend / API iteration when you don't need DeepStream running. Uploads land on disk and show in `/api/uploads`, but no real detection events flow into Redis — use the synthetic publisher (below) to populate them.

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.supabase.yml up
```

For fast HMR, run the frontend separately:

```bash
cd frontend && npm install
cp .env.local.example .env.local   # BACKEND_URL=http://localhost:8080
npm run dev
```

The Next.js dev server proxies `/api/*` and `/ws/*` to `BACKEND_URL` (see `frontend/next.config.js`).

---

## Auth (Supabase, self-hosted)

The stack includes a trimmed self-hosted Supabase (db + GoTrue + Studio + Kong + Storage + MinIO + imgproxy) defined in `docker-compose.supabase.yml`. It replaces the standalone Postgres and provides email+password auth.

### One-time setup

1. Generate secrets and paste into `.env` (real values; `.env` is gitignored — `.env.example` carries placeholders only):
   - `JWT_SECRET` — 32+ byte HS256 secret. `openssl rand -hex 32`.
   - `ANON_KEY` and `SERVICE_ROLE_KEY` — JWTs derived from `JWT_SECRET`. Use https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys (or the supabase CLI's `generate-keys`).
   - `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `S3_PROTOCOL_ACCESS_KEY_ID`, `S3_PROTOCOL_ACCESS_KEY_SECRET` — random strings.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — same value as `ANON_KEY`.
2. Mirror the frontend env: `cp frontend/.env.local.example frontend/.env.local`, then paste `NEXT_PUBLIC_SUPABASE_ANON_KEY` into it. The Next.js dev server only reads `frontend/.env*`, not the repo-root `.env`.
3. Bring the stack up:
   ```bash
   docker compose -f docker-compose.dev.yml -f docker-compose.supabase.yml up -d
   ```
4. Sign up at `http://localhost:3000/signup`. Email autoconfirm is on (`GOTRUE_MAILER_AUTOCONFIRM=true`), so no SMTP needed in dev. To lock down to admin-provisioned accounts only, set `GOTRUE_DISABLE_SIGNUP=true` in `.env` and provision via the admin curl below.

   Admin-provisioned account (when signups are disabled):
   ```bash
   source .env
   curl -X POST http://localhost:8000/auth/v1/admin/users \
     -H "apikey: $SERVICE_ROLE_KEY" \
     -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
     -H "Content-Type: application/json" \
     -d '{"email":"you@example.com","password":"<strong>","email_confirm":true}'
   ```

### Troubleshooting

**`supabase-auth` keeps restarting with `password authentication failed for user "supabase_auth_admin"`.** The db volume was initialized when `POSTGRES_PASSWORD` was blank (often a first-run before `.env` was loaded). The init scripts only run on a fresh data dir. Two options:

- *Nuke and rebuild* (loses any data — fine in dev):
  ```bash
  docker compose -f docker-compose.dev.yml -f docker-compose.supabase.yml down -v
  docker compose -f docker-compose.dev.yml -f docker-compose.supabase.yml up -d
  ```
- *Patch in place* (preserves data):
  ```bash
  source .env
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db psql -U supabase_admin -d postgres \
    -c "ALTER ROLE supabase_auth_admin WITH PASSWORD '$POSTGRES_PASSWORD'; ALTER ROLE supabase_storage_admin WITH PASSWORD '$POSTGRES_PASSWORD';"
  docker restart supabase-auth supabase-storage
  ```

**Backend returns 401 with `{"detail":"invalid_token"}` even after a successful login.** The token's `aud` claim is empty. Caused by users created before `GOTRUE_JWT_AUD=authenticated` was set. Fix the existing rows once:

```bash
source .env
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db psql -U postgres -d postgres \
  -c "UPDATE auth.users SET aud='authenticated', role='authenticated' WHERE aud='';"
```
Then sign out and back in to mint a fresh token.

**Kong consumer keys logged as the literal string `${SUPABASE_ANON_KEY}`.** Kong 2.x doesn't natively interpolate env vars in declarative config; the bash entrypoint in the `kong` service expands `~/temp.yml` → `/home/kong/kong.yml` via `eval echo` before docker-entrypoint hands off. Single-quoted YAML scalars (`_format_version: '1.1'`) are required — double quotes break the eval.

### How it fits together

- **Frontend** (`@supabase/ssr`) stores the session in an httpOnly cookie. The root `middleware.ts` redirects unauthenticated users to `/login` (or `/signup`) and stamps `Authorization: Bearer <jwt>` onto outbound `/api/*` and `/ws/*` requests before Next.js rewrites them to the backend. Pages live under the `(app)` route group with the sidebar layout; `/login` and `/signup` render in the bare root layout.
- **Backend** (`backend/app/auth.py`) verifies the HS256 JWT with `python-jose` against `SUPABASE_JWT_SECRET`, requiring `aud="authenticated"`. Every router include carries `Depends(require_user)` except `events_router` (websocket auth deferred — `TODO(auth)` in `main.py`) and the open `/healthz`.
- **Kong** at `http://localhost:8000` is the gateway: `/auth/v1/*` → GoTrue, `/storage/v1/*` → storage-api, `/pg/*` → postgres-meta. Studio dashboard at the same URL.
- **MinIO console** at `http://localhost:9001` — login with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`.

---

## Using it

Open `http://<HOST_IP>:3000`.

**`/uploads`** — list of every video that has been uploaded, plus a drag-drop uploader and a prompt textarea (free-text, persisted server-side; intent for a future VLM pass).

**`/uploads/[video_id]`** — detail page for one upload:

- HTML5 `<video>` + a custom scrubber overlay that draws per-track detection bands keyed by class colour, plus an incident band layer (severity-coloured, click-to-seek, tooltip with rule label)
- "Detected events" panel on the right with two tabs:
  - **Events** — flat list of tracks with class, max confidence, duration, first bbox; click to seek
  - **Scenarios** — rule-detected incidents (`vehicle_collision`, `ped_impact`, `stationary_vehicle`, `mass_stop`) with severity, confidence, time range, involved track chips, and a "Jump to" button. VLM verdicts (Cosmos NIM or OpenAI, selected via `VLM_PROVIDER`) layer onto the same cards.

**Theme toggle** — Sun/Moon button top-right of the header. Persisted to `localStorage` as `aims-theme`. Pre-hydration script sets the class on `<html>` before paint, so no FOUC.

Inspect Redis directly:

```bash
docker compose exec redis redis-cli XLEN mdx-raw
docker compose exec redis redis-cli XREAD COUNT 5 STREAMS mdx-raw 0
```

Redis Commander (stream UI): available in dev compose only — dropped from prod in Phase 3.

### Support/dev log UI

Structured app logs go to Docker stdout. To view them in Grafana via Loki, start the optional observability overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

Open Grafana at `http://<HOST_IP>:3002` and sign in with `admin` / `admin` unless overridden in `.env`. The provisioned dashboard is **AIMS / AIMS Support/Dev Logs**.

Grafana also provisions one service-specific log page per Loki `service` label, for example **AIMS Service Logs - AIMS Backend**, **AIMS Service Logs - DeepStream vss-rt-cv**, **AIMS Service Logs - Redis**, and **AIMS Service Logs - Postgres**. Regenerate those dashboard JSON files after changing the service list:

```bash
python3 observability/grafana/generate_service_dashboards.py
docker compose -f docker-compose.yml -f docker-compose.observability.yml restart grafana
```

For the no-GPU dev stack:

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.observability.yml up -d
```

Loki label discipline is intentionally low-cardinality: `service`, `env`, `level`, and `logger`. Query `video_id`, `run_id`, and `request_id` by parsing JSON fields in Grafana rather than promoting them to labels.

---

## Synthetic publisher

`tools/synthetic_mdx_publisher.py` generates realistic detection frames (Car / Person / Bicycle, multi-track lifecycle, motion drift) and XADDs them to `mdx-raw` in the exact 13-part DeepStream object format the indexer expects. Each payload carries `sensorId` matching the target `video_id`, so the indexer routes frames into the right `uploads` row (no Redis singleton — post-F1).

`./tools` is mounted read-only into the dev backend at `/app/tools`, so it runs inside the container with no host-side `pip install`:

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-1 --ensure-upload --duration 20 --rate 200
```

`--ensure-upload` stubs an `uploads` row in Postgres so `/uploads/synth-1` works without going through the UI uploader. `--rate 200` backfills faster than realtime; default is `--rate = --fps` (realtime).

`--scenario collision` scripts a two-vehicle collision (overlapping bboxes + simultaneous velocity collapse + sustained stop) so the rule pack in `incident_worker.py` can be exercised end-to-end without GPU time. After publishing, `POST /api/uploads/<id>/analyze` runs the rules and `GET /api/uploads/<id>/incidents` returns the detected incident.

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-collision --ensure-upload \
  --duration 20 --fps 30 --rate 500 --scenario collision

curl -X POST http://localhost:8080/api/uploads/synth-collision/analyze
curl http://localhost:8080/api/uploads/synth-collision/incidents
```

---

## Architecture

```
Browser (Next.js :3000)
    │ /uploads, /uploads/[video_id], theme toggle (light/dark)
    │ shadcn primitives + OpsVision tokens (Synch orange + cool slate ink)
    ▼
FastAPI backend (:8080)  — all /api/* gated by Supabase JWT (require_user)
    │ POST /api/uploads          → save file (scoped to user_id=JWT sub), enqueue
    │ GET  /api/uploads          → list scoped by user_id
    │ GET  /api/uploads/:id      → single row + counts (404 across tenants)
    │ DEL  /api/uploads/:id      → ON DELETE CASCADE drops events
    │ GET  /api/uploads/:id/events?group=tracks|none
    │ GET  /api/uploads/:id/incidents       (rule-detected incidents for the clip)
    │ POST /api/uploads/:id/analyze         (re-run rule pack, returns incidents_found)
    │ GET  /api/uploads/:id/playback        (FileResponse from disk, ownership-checked)
    │ WS   /ws/events?token=…    (live detections for the dashboard overlay)
    ▼
upload_queue (semaphore, MAX_CONCURRENT_STREAMS=2 default)
    │ per-job:
    │   1. rtsp_publisher: ffmpeg -re -i <file> -c copy -f rtsp → mediamtx
    │   2. wait for mediamtx HTTP API sourceReady
    │   3. nvstreamer: POST /api/v1/sensor/add  (NVStreamer registers)
    │   4. deepstream: POST /api/v1/stream/add  (DS nvmultiurisrcbin attaches)
    │   5. plateau watcher (3× identical event counts OR duration_s+60s cap)
    │   6. teardown: stream/remove → sensor delete → ffmpeg stop
    ▼
mediamtx (:8554 internal) ──► NVStreamer (:30000) ──► vss-rt-cv / DeepStream (GPU)
    │ metropolis_perception_app -m 7 -r 2
    │ RT-DETR (TrafficCamNet) → IOU tracker → nvmsgconv → nvmsgbroker
    │ XADD mdx-raw → Redis Stream
    ▼
Redis (:6379)
    ├─ XREAD BLOCK → backend WS broadcaster
    └─ XREADGROUP "indexer/indexer-1" → event_indexer.py
         │ (parses pipe-delimited objects, computes t_seconds via fps lookup)
         ▼
       Postgres (Supabase overlay: supabase-db)
         │ uploads    (video_id PK, prompt, duration_s, w/h, fps, size, uploaded_at)
         │ events     (BIGSERIAL, video_id FK CASCADE, track_id, frame_id,
         │             t_seconds, class, confidence, bbox_x1..y2)
         │ incidents  (UUID PK, video_id FK CASCADE, rule_id, severity,
         │             confidence, t_start_s, t_end_s, frame_start, frame_end,
         │             track_ids, bbox_union JSONB, metadata JSONB)
         │ runs schema.sql at backend startup
            ▲
            │ POST /api/uploads/:id/analyze
            │
       incident_worker.py
         │ reads events, computes per-track + pairwise signals (velocity,
         │ velocity-drop, IOU overlap, co-stop), fires rules:
         │   vehicle_collision · ped_impact · stationary_vehicle · mass_stop
         │ ON CONFLICT upsert keyed on (video_id, rule_id, t_start_s, track_ids)
```

Each `mdx-raw` event payload looks like:

```json
{
  "metadata": "{\"version\":\"4.0\",\"id\":\"5910\",\"sensorId\":\"0\",\"objects\":[\"177|925.0|264.6|993.6|299.9|bicycle|#|||||||0.66\",\"143|855.7|285.0|1023.0|359.0|car|#|||||||0.96\"]}"
}
```

Object string format: `track_id | x1 | y1 | x2 | y2 | class | # | … | confidence` (13 pipe-delimited parts, pixel coords in source video resolution).

---

## Knowledge Base & CMS (Payload)

Payload CMS v3 runs inside the `frontend/` Next.js app and powers two public routes:

- **`/docs`** — Knowledge Base index and article pages (`/docs/[slug]`).
- **`/[...slug]`** — Landing pages built from composable blocks (Hero, FeatureGrid, CTA, etc.).
- **`/admin`** — Payload admin UI for editing content. Payload auth is separate from Supabase — end users browsing `/docs` and the landing pages do **not** need a Supabase session.

### Required env vars

Add to your `.env` (see `.env.example` for placeholders):

```bash
DATABASE_URI=postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres?search_path=payload
PAYLOAD_SECRET=<32-char random string — openssl rand -hex 32>
PAYLOAD_S3_BUCKET=payload-media
```

`S3_PROTOCOL_ACCESS_KEY_ID`, `S3_PROTOCOL_ACCESS_KEY_SECRET`, `STORAGE_S3_ENDPOINT`, and `REGION` are also used by Payload's media storage (shared with the Supabase MinIO instance).

### One-time setup

```bash
# 1. Start the Supabase stack (Postgres + MinIO must be running)
docker compose -f docker-compose.dev.yml -f docker-compose.supabase.yml up -d

# 2. Create the Payload media bucket in MinIO (idempotent — safe to re-run)
bash scripts/create-payload-bucket.sh

# 3. Visit http://localhost:3000/admin and follow the prompt to create the first Payload admin user
```

### Seeding starter content

```bash
cd frontend && npm run seed   # upserts 4 categories, 8 articles, and 1 landing page — idempotent
```

Re-run at any time without creating duplicates. Existing records are updated in place.

### Troubleshooting

**`getaddrinfo EAI_AGAIN db` from `npm run dev` or `npm run seed`.** The repo-root `DATABASE_URI` uses `@db:5432` (compose service DNS). When running Next.js or the seed script on the host, `db` doesn't resolve. Set `DATABASE_URI` in `frontend/.env.local` to `postgresql://postgres:<literal-POSTGRES_PASSWORD>@localhost:5432/postgres?search_path=payload`. Next.js dotenv does not expand `${POSTGRES_PASSWORD}` across files — paste the literal value.

**`Cannot destructure property 'loadEnvConfig' of 'import_env.default' as it is undefined`.** Payload v3.84's `dist/bin/loadEnv.js` does `import nextEnvImport from '@next/env'`, but `@next/env` is a CJS module without a `default` export — fails under Node's current ESM interop. Patch (will be wiped by `npm install`):

```bash
sed -i "s/import nextEnvImport from '@next\\/env';/import * as nextEnvImport from '@next\\/env';/" \
  frontend/node_modules/.pnpm/payload@*/node_modules/payload/dist/bin/loadEnv.js
```

Namespace import (`import * as`) works under both tsx and native Node ESM. A named import (`import { loadEnvConfig }`) parses fine under tsx but throws `SyntaxError: does not provide an export named 'loadEnvConfig'` under Node ESM, because `@next/env`'s CJS bundle assembles `module.exports` dynamically and Node's static analyzer can't see the named exports.

For a durable fix, pin via `pnpm patch` or bump Payload past v3.84 once a release with the fix lands.

**`ValidationError: Excerpt` during seed.** Some seeded excerpts run to 344 chars; the `excerpt` field on `Articles.ts` is capped at 600 (was 280). If you tighten the cap, trim `frontend/src/payload/seed/articles.ts` accordingly.

---

## Known issues

**TRT engine compile (~3.5 min on first run, ~5 s warm).** Normal — RT-DETR ONNX compiles to a TRT FP16 engine on first boot and persists in `data/models/`. Watch `docker compose logs -f vss-rt-cv` for "Starting DeepStream" before uploading. A future Phase 3 item pins the cache to a named volume to survive container rebuilds.

**`libnvds_redis_proto.so` may be missing.** The vss-rt-cv image ships with Kafka as the default broker. If the Redis proto library is absent, detection events won't reach Redis. Verify:

```bash
docker compose exec vss-rt-cv ls /opt/nvidia/deepstream/deepstream/lib/libnvds_redis_proto.so
```

If missing, see comments in `deepstream/init/ds-start.sh` for fallback options (Kafka sidecar, file sink).

**NVStreamer 3.1.0 file-streamer adapter is broken (upstream).** The image ships `launch_vst` compiled against libav60 but ~30 FFmpeg runtime libs are stripped; `POST /api/v1/file` fails. **Bypassed:** uploads are wrapped as RTSP by `rtsp_publisher.py` (ffmpeg → mediamtx) and registered with NVStreamer via `POST /api/v1/sensor/add` instead. The RTSP path uses GStreamer DESCRIBE (no libav) and works cleanly. See [`docs/state/log/2026-05-12-nvstreamer-rediagnosis.md`](docs/state/log/2026-05-12-nvstreamer-rediagnosis.md).

**SDR API is partially documented.** Currently cosmetic in this deployment — `nvds_rest_server` on vss-rt-cv:9000 is the source-add path. SDR container stays up but the backend doesn't drive it.

**Public access (Brev).** `https://ui-blxuttpxb.brevlab.com` (or `https://3000-…`). Cloudflare Access auth happens once, then upload + playback + WebSocket all flow through the same hostname via the Next.js proxy.

---

## Stop

```bash
docker compose down                          # prod
docker compose -f docker-compose.dev.yml down  # dev
```

Postgres data persists in the `aims-pg-data` volume. Redis is ephemeral. Video files and the TRT engine cache persist in `./data/`.

---

## Where things live

- `backend/app/` — FastAPI app, asyncpg pool, event indexer, upload handler, playback, ws broadcast
- `backend/app/schema.sql` — Postgres schema (runs on startup)
- `frontend/src/app/uploads/` — Uploads list + detail page
- `frontend/src/components/ui/` — shadcn primitives (no custom UI)
- `frontend/src/components/theme-{provider,toggle}.tsx` — light/dark toggle
- `frontend/src/app/globals.css` — OpsVision tokens (`@theme inline`) + light overrides
- `deepstream/config/` — perception config, tracker, msgconv (DeepStream side)
- `deepstream/init/ds-start.sh` — DeepStream entrypoint (`metropolis_perception_app`)
- `tools/synthetic_mdx_publisher.py` — GPU-free event generator
- `docs/V1_PLAN.md` — phase status, burn list, deferred items
- `FUTURE_STATE_POT_ARCHIVED.md` — DeepStream reference material from the POT era
