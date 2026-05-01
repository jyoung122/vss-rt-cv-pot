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
```

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
docker compose -f docker-compose.dev.yml up
```

For fast HMR, run the frontend separately:

```bash
cd frontend && npm install
cp .env.local.example .env.local   # BACKEND_URL=http://localhost:8080
npm run dev
```

The Next.js dev server proxies `/api/*` and `/ws/*` to `BACKEND_URL` (see `frontend/next.config.js`).

---

## Using it

Open `http://<HOST_IP>:3000`.

**`/uploads`** — list of every video that has been uploaded, plus a drag-drop uploader and a prompt textarea (free-text, persisted server-side; intent for a future VLM pass).

**`/uploads/[video_id]`** — detail page for one upload:

- HTML5 `<video>` + a custom scrubber overlay that draws per-track detection bands keyed by class colour, plus an incident band layer (severity-coloured, click-to-seek, tooltip with rule label)
- "Detected events" panel on the right with two tabs:
  - **Events** — flat list of tracks with class, max confidence, duration, first bbox; click to seek
  - **Scenarios** — rule-detected incidents (`vehicle_collision`, `ped_impact`, `stationary_vehicle`, `mass_stop`) with severity, confidence, time range, involved track chips, and a "Jump to" button. Phase 8 layers Cosmos-Reason 2 VLM verdicts onto the same cards.

**Theme toggle** — Sun/Moon button top-right of the header. Persisted to `localStorage` as `aims-theme`. Pre-hydration script sets the class on `<html>` before paint, so no FOUC.

Inspect Redis directly:

```bash
docker compose exec redis redis-cli XLEN mdx-raw
docker compose exec redis redis-cli XREAD COUNT 5 STREAMS mdx-raw 0
```

Redis Commander (stream UI): `http://<HOST_IP>:8081` (will be dropped from the prod compose in Phase 3).

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

`tools/synthetic_mdx_publisher.py` generates realistic detection frames (Car / Person / Bicycle, multi-track lifecycle, motion drift) and XADDs them to `mdx-raw` in the exact 13-part DeepStream object format the indexer expects. It also sets `current_video_id` so the indexer routes frames into the right `uploads` row.

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
FastAPI backend (:8080)
    │ POST /api/uploads          → save file, ffprobe meta, INSERT uploads row
    │                             → SET current_video_id, restart vss-rt-cv
    │ GET  /api/uploads          → list with track/event counts
    │ GET  /api/uploads/:id      → single row + counts
    │ DEL  /api/uploads/:id      → ON DELETE CASCADE drops events
    │ GET  /api/uploads/:id/events?group=tracks|none
    │ GET  /api/uploads/:id/incidents       (rule-detected incidents for the clip)
    │ POST /api/uploads/:id/analyze         (re-run rule pack, returns incidents_found)
    │ GET  /api/uploads/:id/playback        (FileResponse from disk)
    │ WS   /ws/events            (live detections for the dashboard overlay)
    ▼
NVStreamer (:30000)              ← bypassed; see "NVStreamer 3.1.0" below
    │ (file:// URL is written directly to current_stream_url.txt)
    ▼
vss-rt-cv / DeepStream (GPU)
    │ metropolis_perception_app -m 7 -r 2
    │ RT-DETR (TrafficCamNet) → IOU tracker → nvmsgconv → nvmsgbroker
    │ XADD mdx-raw → Redis Stream
    ▼
Redis (:6379)
    ├─ XREAD BLOCK → backend WS broadcaster
    └─ XREADGROUP "indexer/indexer-1" → event_indexer.py
         │ (parses pipe-delimited objects, computes t_seconds via fps lookup)
         ▼
       Postgres 16 (aims db)
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

## Known issues

**TRT engine compile (~3.5 min on first run, ~5 s warm).** Normal — RT-DETR ONNX compiles to a TRT FP16 engine on first boot and persists in `data/models/`. Watch `docker compose logs -f vss-rt-cv` for "Starting DeepStream" before uploading. A future Phase 3 item pins the cache to a named volume to survive container rebuilds.

**`libnvds_redis_proto.so` may be missing.** The vss-rt-cv image ships with Kafka as the default broker. If the Redis proto library is absent, detection events won't reach Redis. Verify:

```bash
docker compose exec vss-rt-cv ls /opt/nvidia/deepstream/deepstream/lib/libnvds_redis_proto.so
```

If missing, see comments in `deepstream/init/ds-start.sh` for fallback options (Kafka sidecar, file sink).

**NVStreamer 3.1.0 discovery bug (upstream, unresolved).** NVStreamer 3.1.0 fails to populate codec/container metadata for files it serves and rejects them with "Codec format not supported"; the documented `POST /api/v1/file` returns 404 in this build. **Workaround in place:** `/api/uploads` writes `file:///data/videos/<filename>` directly to `current_stream_url.txt` and DeepStream reads via `uridecodebin`. NVStreamer is still up but not in the perception path.

**SDR API is partially documented.** If stream registration fails, check `docker compose logs sdr`; expected request body lives in `backend/app/sdr.py`.

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
- `../V1_PLAN.md` — phase status, burn list, deferred items
- `FUTURE_STATE_POT_ARCHIVED.md` — DeepStream reference material from the POT era
