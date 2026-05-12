# AGENTS.md — SSI AIMS

Read this before editing. The repo dir is `aims/` (renamed from `vss-rt-cv-pot/` in Phase 4).

## What this is

Real-time computer vision monitoring. Upload a video → DeepStream perception (RT-DETR / TrafficCamNet) → raw events to Redis Streams (`mdx-raw`) → indexer drains to Postgres → Next.js UI lets you scrub the timeline and inspect per-track detections.

Not an integration target anymore. POT is the app.

## Repo map

```
backend/            FastAPI + asyncpg + redis. Lifespan starts the event indexer.
  app/main.py       routes + lifespan + RequestIdMiddleware
  app/db.py         asyncpg pool, runs schema.sql at startup
  app/schema.sql    uploads + events + incidents tables (raw SQL, no ORM)
  app/upload.py     ffprobe metadata, INSERT uploads, enqueues via upload_queue
  app/upload_queue.py   in-process job queue + serial worker. Owns current_video_id,
                        current_stream_url.txt, and the vss-rt-cv container restart.
                        Caps depth at UPLOAD_QUEUE_MAX_DEPTH (default 10) → 503.
  app/uploads_list.py   GET/DELETE /api/uploads, GET /api/uploads/:id/events,
                        GET /api/uploads/:id/progress (queue + ingest + VLM aggregate)
  app/event_indexer.py  XREADGROUP("indexer/indexer-1") → Postgres events
  app/incidents.py      GET /api/uploads/:id/incidents, POST /api/uploads/:id/analyze
                        GET /api/incidents/catalog
  app/incident_worker.py rule pack: vehicle_collision · ped_impact ·
                          stationary_vehicle · mass_stop. ON CONFLICT upsert so
                          vlm_* columns survive re-analyze.
  app/vlm_validator.py  Clip extraction (ffmpeg) + provider.validate() + write-back.
                        Spawned by analyze endpoint. VLM_ENABLED=false → skipped.
  app/vlm_providers/    Swappable VLM provider package — selector reads VLM_PROVIDER,
                        cosmos.py / openai_provider.py are isolated (no cross-imports).
                        Shared prompts.py + parsing.py.
  app/logging_config.py LOG_LEVEL + LOG_FORMAT=text|json. OTel-envelope JSON Lines.
                        contextvars request_id / run_id / video_id propagation.
  app/playback.py   GET /api/uploads/:id/playback (FileResponse from disk)
  tests/            unit tests (run: python -m unittest backend.tests.<name>)

frontend/           Next.js 15.3 + React 19 + TS, Tailwind v4
  src/app/uploads/page.tsx              list + drag-drop upload
  src/app/uploads/[video_id]/page.tsx   detail (video + scrubber + tabs)
  src/app/incidents/page.tsx            incident catalog + config page
  src/components/ui/                    shadcn primitives (DO NOT replace with custom)
  src/components/theme-provider.tsx     html.dark|light + localStorage
  src/components/theme-toggle.tsx       header sun/moon button
  src/app/globals.css                   OpsVision tokens (@theme inline) + light overrides
  src/app/layout.tsx                    SidebarProvider h-svh + theme + tooltip wrappers
  src/lib/logger.ts                     OTel-envelope logger; mirrors backend envelope.
  next.config.js                        proxies /api/* and /ws/* to BACKEND_URL

deepstream/         perception-config.txt, ds-start.sh, tracker + msgconv configs
docker-compose.yml          prod: redis, postgres, nvstreamer, sdr, vss-rt-cv, backend, frontend
docker-compose.dev.yml      dev: redis + postgres + backend only (no GPU)
docker-compose.observability.yml  optional overlay: Loki + Promtail + Grafana (:3002)
observability/      loki.yml, promtail.yml, grafana/ (provisioned datasource + dashboards)
scripts/vm_setup.sh     Brev/Ubuntu bootstrap (docker, NVIDIA toolkit, NGC CLI)
tools/synthetic_mdx_publisher.py  XADDs realistic mdx-raw frames (no GPU needed)
```

Reference (don't trust as current state): [`FUTURE_STATE_POT_ARCHIVED.md`](FUTURE_STATE_POT_ARCHIVED.md) has DeepStream config notes that are still accurate.

## Conventions — read before editing

**UI**
- shadcn-only. Use `@/components/ui/*` (Button, Dialog, Card, Tabs, Badge, Tooltip, Skeleton, Sidebar). Don't roll custom `<button>` / `role="dialog"`. If a primitive is missing, add it from shadcn rather than inlining.
- Tailwind v4 (CSS-based config). Tokens live in `src/app/globals.css` under `@theme inline` — OpsVision palette: Synch orange `#ea6a22` accent on cool slate ink scale.
- Themes: `html.dark` (default) and `html.light`. Tokens cascade through CSS vars; don't hardcode hex.
- Fonts: `Inter`, `Space Grotesk` (display), `JetBrains Mono` — loaded via `next/font/google` in `layout.tsx`.
- Layout shell uses `h-svh` + `min-h-0` chain so per-page scroll is bounded to viewport. If you add a full-height column, follow the existing pattern (parent `flex min-h-0 flex-1 flex-col` → child `flex-1 overflow-auto`).

**Backend**
- Raw SQL via asyncpg. No ORM. Schema lives in `schema.sql` and runs at startup.
- Per-run `video_id` is `{stem}-{timestamp}` so re-uploads append rows.
- Background work runs via `asyncio.create_task` in the FastAPI lifespan, not threads.
- Use `logging.getLogger(__name__)` — not `print()`. Pass structured fields via `extra={...}` on the log call. See `app/logging_config.py` for the Timer helper and context-var setters.

**Vocabulary lock**
- **Event** = raw detection (class, confidence, bbox, frame). One row per object per frame.
- **Incident** = rule-detected behavioral pattern over time (collision, ped impact, stationary vehicle, traffic anomaly). Lives in the `incidents` table; produced by `incident_worker.py`. Phase 8 layers Cosmos-Reason 2 VLM verdicts on the same rows.
- **Scenario** = the UI surface for incidents on the detail page. The tab is live (no longer disabled).

**Other**
- Auth: Supabase JWT (HS256, `aud=authenticated`). Frontend middleware injects `Authorization: Bearer …` into `/api/*`; backend `require_user` validates. Every upload row is scoped by `user_id` (= JWT `sub`), so users only see their own data. WS `/ws/events` takes `?token=…` (browsers can't set headers on WS upgrade). Legacy rows with NULL `user_id` are invisible to all users — handled separately in Phase E. See [`docs/v1/phases/multi-user-uploads.md`](docs/v1/phases/multi-user-uploads.md).
- Defaults assume single-tenant single-host (one GPU pipeline, serial processing). Don't generalize prematurely.
- Repo dir rename to `aims/` is Phase 4. Don't rename docker container names / volumes ahead of that — it'll churn the diff.

## Run it

Prod (GPU host):
```bash
./scripts/vm_setup.sh           # one-time, on a fresh VM
cp .env.example .env            # set NGC_CLI_API_KEY, HOST_IP, DATA_DIR
docker compose up -d
```

Dev (no GPU, frontend/API iteration):
```bash
docker compose -f docker-compose.dev.yml up
cd frontend && npm install && npm run dev   # HMR on :3000, proxies to :8080
```

Generate synthetic events without a GPU:
```bash
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-1 --ensure-upload --duration 20 --rate 200
# → visit http://localhost:3000/uploads/synth-1
```

Exercise the rule pack with a scripted collision (no GPU needed):
```bash
docker compose -f docker-compose.dev.yml exec backend \
  python /app/tools/synthetic_mdx_publisher.py \
  --video-id synth-collision --ensure-upload \
  --duration 20 --fps 30 --rate 500 --scenario collision
curl -X POST http://localhost:8080/api/uploads/synth-collision/analyze
# → {"incidents_found": 1+}
```

## Where to look first

- Roadmap + burn list: [`docs/V1_PLAN.md`](docs/V1_PLAN.md)
- Onboarding + architecture: [`README.md`](README.md)
- Current state snapshot: [`docs/state/snapshot.md`](docs/state/snapshot.md). Index + per-session log: [`CURRENT_STATE.md`](CURRENT_STATE.md) → [`docs/state/log/`](docs/state/log/).
- Migration history (POT → AIMS): [`../MIGRATION_MAP.md`](../MIGRATION_MAP.md)
- Archived integration plan: [`../V1_PLAN_INTEGRATION_ARCHIVED.md`](../V1_PLAN_INTEGRATION_ARCHIVED.md)
- DeepStream reference (archived but still accurate): [`FUTURE_STATE_POT_ARCHIVED.md`](FUTURE_STATE_POT_ARCHIVED.md)
