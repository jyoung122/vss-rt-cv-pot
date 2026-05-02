# Frontend

Next.js 15.3 + React 19 + TypeScript application. Provides the SSI AIMS user interface: upload management, per-upload timeline scrubber with detection bands and incident bands, an incident catalog, and an analytics dashboard. Proxies all `/api/*` and `/ws/*` traffic to the backend — it has no direct database or Redis connection.

## Container / process

- **Build context:** `./frontend` (multi-stage Dockerfile; `deps` → `builder` → `runner`)
- **Compose service name:** `frontend`
- **Container name:** `vss-frontend`
- **Network:** `vss-net`
- **Dependencies:** `backend` (service_healthy)
- **Ports:** `3000:3000` (host:container)
- **Volumes:** none (static build artifact only)
- **Healthcheck:** none defined (relies on backend healthcheck gate)

## Configuration

Required env vars (see [`.env.example`](../../../.env.example)):

| Var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_LOG_LEVEL` | `INFO` | Minimum log level for the browser/server logger |
| `NEXT_PUBLIC_LOG_FORMAT` | `json` | `text` or `json` — mirrors the backend envelope |
| `NEXT_PUBLIC_SERVICE_NAME` | `aims-frontend` | `service` label in log output |

`BACKEND_URL` is set in `frontend/.env.local` for local dev (not in the compose env). It defaults to `http://backend:8080` inside the container via `next.config.js` rewrites.

### Optional knobs

- `LOKI_TAG` / `GRAFANA_PORT` — only relevant for the observability overlay, not the frontend itself.

## Endpoints / interfaces

The frontend consumes:

| Backend route | Usage |
|---|---|
| `GET /api/uploads` | Dashboard KPIs + uploads list |
| `POST /api/uploads` | Drag-drop file upload |
| `GET /api/uploads/:id` | Upload detail header |
| `GET /api/uploads/:id/events?group=tracks\|none` | Scrubber track bands + Events tab |
| `GET /api/uploads/:id/incidents` | Scenarios tab + incident scrubber bands |
| `POST /api/uploads/:id/analyze` | Re-run incident rule pack |
| `GET /api/uploads/:id/playback` | Video playback (FileResponse) |
| `GET /api/incidents/catalog` | Cross-upload incident browser |
| `GET /api/incidents/config` | Rule threshold config page |
| `PUT /api/incidents/config/:rule_id` | Live threshold edits |
| `WS /ws/events` | Live detection overlay on the dashboard |

## Runbook

### Dev (HMR)

```bash
# Start the backing services (no GPU needed)
docker compose -f docker-compose.dev.yml up -d

# Run frontend with hot-module reload
cd frontend
npm install
cp .env.local.example .env.local   # set BACKEND_URL=http://localhost:8080
npm run dev
# Open http://localhost:3000
```

### Prod (Docker)

```bash
docker compose up -d frontend
docker logs -f vss-frontend
```

### Tail logs

```bash
docker logs -f vss-frontend
# Or via Grafana (observability overlay): filter service=aims-frontend
```

### Rebuild after code changes

```bash
docker compose build frontend && docker compose up -d frontend
```

### Build cache stale

If you see `Cannot find module for page: /_document` after major changes:

```bash
rm -rf frontend/.next && cd frontend && npm run build
```

`next build` cosmetically reformats `frontend/tsconfig.json`. Revert before committing:

```bash
git checkout frontend/tsconfig.json
```

## Known issues / gotchas

- **`node_modules` collision in Docker build.** The `frontend/.dockerignore` excludes `node_modules` and `.next`. Do not delete it — see [`../../gotchas.md`](../../gotchas.md#frontend-build-fails-with-cannot-replace-to-directory--node_modules-with-file).
- **No healthcheck on the container.** The compose `depends_on: backend: condition: service_healthy` ensures the API is up before the frontend starts, but there is no explicit frontend healthcheck.

## Related plan items

- [Phase 2 — UI improvements](../../../V1_PLAN.md#phase-2--ui-improvements-lift-ivm-shell) — design system lift, shadcn primitives, OpsVision tokens
- [Phase 7/8 follow-on — incidents UX polish](../../../V1_PLAN.md#phase-78-follow-on--incidents-ux-polish) — incidents catalog, scrubber bands, live-editable thresholds
- [Phase 9 — Observability v0](../../../V1_PLAN.md#phase-9--supportdev-observability-v0) — `frontend/src/lib/logger.ts` OTel envelope
