# V1 Architecture — SSI AIMS

SSI AIMS is a single-VM computer-vision monitoring system. A user uploads a video clip; the system detects objects, applies behavioral incident rules, and optionally validates flagged incidents with a vision-language model (VLM). All output is surfaced in a browser UI.

---

## High-level diagram

```
Browser
  │
  │ HTTP / WebSocket
  ▼
┌────────────────┐
│   Frontend     │  Next.js 15 / React 19
│  (vss-frontend)│  port 3000
└───────┬────────┘
        │ /api/* /ws/* rewrites
        ▼
┌────────────────────────────────────────────────────────┐
│                    Backend                             │
│               (vss-backend)  port 8080                 │
│                                                        │
│  upload.py ─── ffprobe metadata                        │
│  event_indexer.py ◄─── mdx-raw (Redis XREADGROUP)     │
│  incident_worker.py ─── rule pack (4 rules)            │
│  vlm_validator.py ──── Cosmos API + ffmpeg clip        │
│  incidents.py, uploads_list.py ─── REST responses      │
│  events.py ─── WebSocket broadcaster                  │
└──────┬────────────┬─────────────────┬─────────────────┘
       │            │                 │
       ▼            ▼                 ▼
┌──────────┐  ┌──────────┐   ┌──────────────────┐
│  Postgres │  │  Redis   │   │  DeepStream      │
│  port 5432│  │  port 6379│   │  (vss-rt-cv)    │
│           │  │           │   │                  │
│ uploads   │  │ mdx-raw   │   │ metropolis_      │
│ events    │  │ stream    │   │ perception_app   │
│ incidents │  │           │   │ RT-DETR / IOU   │
│ rule_config│  └──────────┘   │ tracker          │
└──────────┘                  └────────┬─────────┘
                                       │ writes mdx-raw
                                       │ (GPU, device 0)
                              ┌────────▼─────────┐
                              │   video file      │
                              │  current_stream_  │
                              │  url.txt          │
                              └───────────────────┘

                              ┌──────────────────┐
                              │  Cosmos NIM       │
                              │  (aims-cosmos)    │
                              │  port 8000        │
                              │                   │
                              │ Cosmos-Reason2-2B │
                              │ ~15 GB weights    │
                              │ OpenAI-compat API │
                              └──────────────────┘
                                  ▲
                                  │ POST /v1/chat/completions
                                  │ (base64 video clip)
                              vlm_validator.py

                              ┌──────────────────┐
                              │  Observability    │
                              │  (optional)       │
                              │  Loki · Promtail  │
                              │  Grafana :3001    │
                              └──────────────────┘
```

All containers share a single Docker bridge network: `vss-net`.

---

## Data flows

### 1. Upload → detection

```
User drags video onto the UI
  → POST /api/uploads  (multipart)
  → backend: ffprobe extracts duration/fps/resolution, inserts uploads row
  → backend: writes data/videos/current_stream_url.txt (file:// URI)
  → backend: restarts vss-rt-cv via Docker socket
  → vss-rt-cv: reads the URI file on next start, processes the clip
  → vss-rt-cv: emits detection frames to Redis mdx-raw stream
  → event_indexer (asyncio task): XREADGROUP drain → inserts events rows
  → WebSocket broadcaster: tails mdx-raw, pushes live frames to browser
```

### 2. Analysis → VLM verdict

```
User clicks "Analyze" (or backend auto-triggers post-index)
  → POST /api/uploads/:id/analyze
  → incident_worker: reads events from Postgres, runs 4 rule functions
      vehicle_collision — sustained bounding-box overlap + co-deceleration
      ped_impact        — person–vehicle overlap exceeding velocity threshold
      stationary_vehicle — track stationary for N consecutive frames
      mass_stop          — ≥3 vehicles stopping within a short time window
  → inserts incidents rows (vlm_status='pending')
  → vlm_validator (if VLM_ENABLED=true):
      ffmpeg extracts a short clip around each incident timestamp
      encodes clip as base64
      POST /v1/chat/completions → aims-cosmos
      parses verdict JSON from response (strips <think> tags)
      updates incidents row: vlm_status='confirmed'|'rejected'|'uncertain'
  → returns {"incidents_found": N}
```

### 3. Dashboard / browsing

```
Browser loads /
  → GET /api/uploads → KPI counts + recent uploads table
  → WS /ws/events    → live detection overlay (if DeepStream running)

Browser opens /uploads/:id
  → GET /api/uploads/:id/events?group=tracks → scrubber track bands
  → GET /api/uploads/:id/incidents           → scrubber incident bands + Scenarios tab
  → GET /api/uploads/:id/playback            → video stream (FileResponse)

Browser opens /incidents
  → GET /api/incidents/catalog → cross-upload incident list
  → GET /api/incidents/config  → rule thresholds (editable in UI)
```

---

## Service inventory

| Service | Container | Role | GPU |
|---|---|---|---|
| Frontend | `vss-frontend` | Next.js UI; proxies all API/WS traffic | no |
| Backend | `vss-backend` | FastAPI hub: upload handler, event indexer, incident worker, VLM orchestration | no |
| DeepStream | `vss-rt-cv` | Object detection (RT-DETR / TrafficCamNet) + IOU tracker → `mdx-raw` | yes (always) |
| Cosmos | `aims-cosmos` | Cosmos-Reason2-2B NIM; VLM second-pass verdict on incidents | yes (on-demand) |
| Postgres | `vss-postgres` | Persistent store: `uploads`, `events`, `incidents`, `rule_config` | no |
| Redis | `vss-redis` | `mdx-raw` stream bus between DeepStream and backend | no |
| NVStreamer | `nvstreamer` | Video ingest sidecar — bypassed in v1 (upload-only mode) | no |
| SDR | `sdr` | Stream Discovery & Registration — cosmetic in v1 | no |
| Loki/Promtail/Grafana | *(optional overlay)* | Log aggregation and UI for support/dev | no |

---

## Postgres schema

Four tables (defined in `backend/app/schema.sql`):

```
uploads
  id TEXT PK, filename, duration_s, fps, resolution, status, created_at

events
  id SERIAL PK, upload_id FK, track_id, object_class,
  x1 y1 x2 y2 (bounding box), confidence, frame_number, timestamp_s

incidents
  id SERIAL PK, upload_id FK, rule_id, severity,
  start_s, end_s, confidence,
  vlm_status (pending|confirmed|rejected|uncertain|skipped),
  vlm_reasoning, vlm_confidence, metadata JSONB

rule_config
  rule_id PK, thresholds JSONB
```

Events are the raw per-frame detection records. Incidents are the rule-derived conclusions. The VLM writes back into `incidents` in-place.

---

## GPU topology

Both GPU consumers share device 0:

| Consumer | VRAM | When active |
|---|---|---|
| DeepStream (RT-DETR FP16) | ~3 GB | During video processing (clip playback loop) |
| Cosmos-Reason2-2B (BF16) | ~5–6 GB | During `POST /analyze` only |

Peak combined ~9 GB — well within the A6000's 48 GB. The two consumers do not overlap in normal operation (DeepStream processes the clip first; Cosmos runs after indexing completes).

---

## Key design decisions

| Decision | Rationale |
|---|---|
| Upload-only (no live RTSP) | Simplifies demo reliability; NVStreamer/SDR wired but bypassed |
| No auth | Firewall-restricted demo VM; auth deferred to v2 |
| Custom incident worker (not NVIDIA behavior-analytics) | Upstream service lacks collision / ped-impact rules; custom worker writes `mdx-incidents`-compatible schema for a future swap |
| Cosmos self-hosted via NIM | Avoids cloud egress cost; A6000 fits both DeepStream + 2B params comfortably |
| IOU tracker (not NvDCF) | Simpler, no calibration needed; track-ID swaps under occlusion are a known v1.5 item |
| asyncio tasks inside FastAPI lifespan | event_indexer and incident_worker are lightweight enough to co-locate; avoids a separate worker process for v1 |
| Docker socket mount on backend | Lets the upload handler restart `vss-rt-cv` in-process without an external orchestrator |
| Raw SQL / asyncpg (no ORM) | Schema is small and stable; ORM overhead not justified |

---

## Startup order (Compose dependency chain)

```
postgres ──healthy──► backend ──healthy──► frontend
redis    ──healthy──►
redis    ──healthy──► vss-rt-cv
sdr      ──started──►
```

Cosmos has no Compose dependency declared — the backend connects to it asynchronously after its 10-minute healthcheck window.

---

## Technology stack

| Layer | Choice |
|---|---|
| UI | Next.js 15.3, React 19, TypeScript, Tailwind v4, shadcn-style components |
| API | FastAPI (Python 3.11), asyncpg, uvicorn |
| Perception | NVIDIA DeepStream 9.0, RT-DETR / TrafficCamNet ResNet-50 FP16 |
| VLM | Cosmos-Reason2-2B via NVIDIA NIM (OpenAI-compat API) |
| Stream bus | Redis 8 (`mdx-raw` stream, XREADGROUP) |
| Database | Postgres 16 |
| Observability | Loki 3 + Promtail + Grafana 10 (optional overlay) |
| Container runtime | Docker Compose (single VM) |
