# Postgres

Postgres 16 (Alpine) — the persistent store for all AIMS application data. The backend's asyncpg pool connects to it on startup and runs `schema.sql` idempotently (all DDL uses `IF NOT EXISTS` / `IF NOT EXISTS` guards). No ORM; all queries are raw SQL via asyncpg.

## Container / process

- **Image:** `postgres:16-alpine`
- **Compose service name:** `postgres`
- **Container name:** `aims-postgres`
- **Network:** `vss-net`
- **Dependencies:** none
- **Ports:** none exposed to host (internal only on `vss-net`)
- **Volumes:**
  - `aims-pg-data:/var/lib/postgresql/data` — named volume; persists across container restarts and `docker compose down`
- **Healthcheck:** `pg_isready -U aims -d aims` every 10 s, 10 s start_period

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `POSTGRES_USER` | `aims` | Superuser / app user (hardcoded in compose) |
| `POSTGRES_PASSWORD` | `${POSTGRES_PASSWORD:-aims}` | Password — set in `.env` |
| `POSTGRES_DB` | `aims` | Database name |
| `DATABASE_URL` | `postgresql://aims:aims@postgres:5432/aims` | Connection string used by the backend |

See [`.env.example`](../../.env.example).

## Endpoints / interfaces

Internal only — reached by the backend via `DATABASE_URL` on `vss-net`. Not exposed to the host.

### Schema

Defined in [`backend/app/schema.sql`](../../backend/app/schema.sql):

| Table | Description |
|---|---|
| `uploads` | One row per uploaded video (`video_id` PK, ffprobe metadata, prompt, timestamps) |
| `events` | Raw detection rows from the event indexer (`video_id` FK CASCADE) |
| `incidents` | Rule-detected + VLM-validated incidents (`video_id` FK CASCADE) |
| `rule_config` | User-tunable rule thresholds (upserted on first PUT) |

## Runbook

### Ad-hoc query

```bash
docker exec aims-postgres psql -U aims -d aims -c "SELECT count(*) FROM events;"
```

### Inspect uploads

```bash
docker exec aims-postgres psql -U aims -d aims \
  -c "SELECT video_id, uploaded_at, duration_s FROM uploads ORDER BY uploaded_at DESC LIMIT 10;"
```

### Tail logs

```bash
docker logs -f aims-postgres
```

### Restart cleanly

```bash
docker compose restart postgres
# Data persists in aims-pg-data volume
```

### Full data wipe

```bash
docker compose down -v   # removes aims-pg-data volume
```

## Known issues / gotchas

- **Postgres data persists in the named volume** (`aims-pg-data`) across `docker compose down`. To wipe all data, use `docker compose down -v`.
- **Schema is applied at backend startup** via `CREATE TABLE IF NOT EXISTS`. If you change `schema.sql`, restart the backend to apply changes. For destructive changes (column drops, renames), run the migration SQL manually.
- **`CannotConnectNowError` on backend cold start.** If the backend lifespan starts before Postgres finishes init, asyncpg retries. The Compose `depends_on: condition: service_healthy` reduces but doesn't eliminate this race. See [`../gotchas.md`](../gotchas.md#backend-logs-asyncpgexceptionscannotconnectnowerror).

## Related plan items

- [Phase 3 — Backend hardening (healthchecks)](../../V1_PLAN.md#phase-3--backend-hardening-for-prod-ish) (burn-list item 5)
- [Phase 7 — `incidents` table](../../V1_PLAN.md#phase-7--incident-detection-rules-phase-a) (burn-list item 17)
