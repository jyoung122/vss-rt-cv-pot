# Backend

FastAPI application that is the central hub of the AIMS pipeline. It handles video uploads (with ffprobe metadata extraction), manages the Redis → Postgres event indexer, exposes all REST and WebSocket endpoints consumed by the frontend, runs the incident rule pack (`incident_worker.py`), and orchestrates VLM validation via `vlm_validator.py`. The incident worker and VLM validator are **not** separate processes — they run as `asyncio.create_task` tasks inside the same FastAPI lifespan.

## Container / process

- **Build context:** `./backend` (Dockerfile in that dir)
- **Compose service name:** `backend`
- **Container name:** `vss-backend`
- **Network:** `vss-net`
- **Dependencies:** `redis` (service_healthy), `sdr` (service_started), `postgres` (service_healthy)
- **Ports:** `8080:8080` (host:container)
- **Volumes:**
  - `${DATA_DIR}/videos:/data/videos` — uploaded video files and `current_stream_url.txt`
  - `/var/run/docker.sock:/var/run/docker.sock` — used by the upload handler to restart `vss-rt-cv` after a new upload
- **Healthcheck:** `curl -fsS http://localhost:8080/healthz` every 10 s, 30 s start_period

### Internal modules

| Module | Responsibility |
|---|---|
| `main.py` | Routes, lifespan (starts event indexer task), RequestIdMiddleware |
| `db.py` | asyncpg pool; runs `schema.sql` at startup |
| `schema.sql` | DDL for `uploads`, `events`, `incidents`, `rule_config` tables |
| `upload.py` | ffprobe metadata, INSERT uploads, writes `current_stream_url.txt`, restarts `vss-rt-cv` |
| `uploads_list.py` | `GET/DELETE /api/uploads`, `GET /api/uploads/:id/events` |
| `event_indexer.py` | XREADGROUP consumer-group drain of `mdx-raw` → `events` rows |
| `incidents.py` | Incident REST endpoints + catalog |
| `incident_worker.py` | Rule pack: `vehicle_collision`, `ped_impact`, `stationary_vehicle`, `mass_stop` |
| `vlm_validator.py` | Clip extraction (ffmpeg) + Cosmos API call + verdict write-back |
| `playback.py` | `GET /api/uploads/:id/playback` — FileResponse from disk |
| `sdr.py` | SDR stream registration calls (currently cosmetic in upload-only mode) |
| `redis_client.py` | Shared Redis connection helpers |
| `logging_config.py` | `LOG_LEVEL`/`LOG_FORMAT`, OTel JSON Lines envelope, Timer, context-var propagation |
| `events.py` | WebSocket broadcaster (`/ws/events`) |

## Configuration

Required env vars (see [`.env.example`](../../.env.example)):

| Var | Default | Purpose |
|---|---|---|
| `HOST_IP` | — | Passed through to downstream services |
| `DATABASE_URL` | `postgresql://aims:aims@postgres:5432/aims` | asyncpg connection string |
| `REDIS_HOST` | `redis` | Redis hostname on `vss-net` |
| `REDIS_PORT` | `6379` | Redis port |
| `DATA_DIR` | `/data` | Root for video storage inside the container |
| `SDR_URL` | `http://sdr:4001` | SDR registration endpoint |
| `NVSTREAMER_URL` | `http://nvstreamer:30000` | NVStreamer API base |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `LOG_FORMAT` | `json` | `text` (human) or `json` (OTel JSON Lines) |
| `SERVICE_NAME` | `aims-backend` | `service` field in log output |
| `ENV` | `prod` | `dev` or `prod`; affects some log defaults |
| `VLM_ENABLED` | `false` | `true` to run Cosmos validation after incident detection |
| `COSMOS_URL` | `http://cosmos:8000` | Base URL for the Cosmos NIM container |

## Endpoints / interfaces

### HTTP

| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Health check (also aliased as `/health`) |
| `POST` | `/api/uploads` | Upload a video file; returns `video_id` |
| `GET` | `/api/uploads` | List all uploads with counts |
| `GET` | `/api/uploads/:id` | Single upload detail + counts |
| `DELETE` | `/api/uploads/:id` | Delete upload + cascade events/incidents |
| `GET` | `/api/uploads/:id/events` | Events for an upload (`?group=tracks\|none`) |
| `GET` | `/api/uploads/:id/incidents` | Incidents for an upload |
| `POST` | `/api/uploads/:id/analyze` | Re-run rule pack + VLM (if enabled) |
| `GET` | `/api/uploads/:id/playback` | Stream video file |
| `GET` | `/api/incidents/catalog` | Cross-upload incident list |
| `GET` | `/api/incidents/config` | All rule thresholds |
| `PUT` | `/api/incidents/config/:rule_id` | Update thresholds for one rule |

### WebSocket

| Path | Description |
|---|---|
| `/ws/events` | Live `mdx-raw` detections broadcast to connected clients |

### Redis streams

| Stream | Role |
|---|---|
| `mdx-raw` | Read via XREADGROUP (`indexer/indexer-1`). Also tailed by the WS broadcaster. |

### Postgres tables

`uploads`, `events`, `incidents`, `rule_config` — see [`backend/app/schema.sql`](../../backend/app/schema.sql).

## Runbook

### Start standalone (dev, no GPU)

```bash
docker compose -f docker-compose.dev.yml up -d
docker logs -f vss-backend
```

### Run unit tests

```bash
cd backend
python -m unittest backend.tests.test_incident_worker
```

### Tail logs

```bash
docker logs -f vss-backend
# Or in Grafana (observability overlay): filter service=aims-backend
```

### Restart cleanly

```bash
docker compose restart backend
```

### Trigger incident analysis manually

```bash
curl -X POST http://localhost:8080/api/uploads/<video_id>/analyze
# Returns {"incidents_found": N}
```

### Exercise rule pack without GPU

```bash
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-collision --ensure-upload \
  --duration 20 --fps 30 --rate 500 --scenario collision

curl -X POST http://localhost:8080/api/uploads/synth-collision/analyze
curl http://localhost:8080/api/uploads/synth-collision/incidents
```

## Known issues / gotchas

- **`CannotConnectNowError` on first boot.** Postgres may still be initialising when the backend lifespan connects. Uvicorn retries and the second attempt succeeds. If startup fails, `docker compose restart backend`. See [`../gotchas.md`](../gotchas.md#backend-logs-asyncpgexceptionscannotconnectnowerror).
- **SDR DNS error on cold start.** The upload handler tries to register the stream with SDR. Transient DNS failure observed once (2026-04-30); does not block detection flow in upload-only mode. See [`../gotchas.md`](../gotchas.md#backend-logs-error-registering-stream-with-sdr).
- **JSONB columns decoded via `_jsonb()` helper.** A `set_type_codec` on pool init would be cleaner; noted as future cleanup in the code.
- **VLM hallucination.** Cosmos may confirm incidents that didn't happen. The UI always renders rule confidence alongside the VLM pill. See V1_PLAN risk watch.

## Related plan items

- [Phase 3 — Backend hardening](../../V1_PLAN.md#phase-3--backend-hardening-for-prod-ish)
- [Phase 7 — Incident detection rules](../../V1_PLAN.md#phase-7--incident-detection-rules-phase-a)
- [Phase 8 — Cosmos-Reason2-2B VLM validation](../../V1_PLAN.md#phase-8--cosmos-reason2-2b-vlm-validation-phase-b)
- [Phase 9 — Observability v0](../../V1_PLAN.md#phase-9--supportdev-observability-v0)
