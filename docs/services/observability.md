# Observability (Loki / Promtail / Grafana)

Optional support/dev log UI overlay, defined in `docker-compose.observability.yml`. Collects structured JSON Lines stdout from all AIMS containers via Promtail → Loki, and exposes them in a pre-provisioned Grafana dashboard. Scope is intentionally narrow: support and developer debugging. It is not an operator status page, SRE alerting stack, or auditor-grade search index.

Activate by composing the overlay file on top of either the prod or dev stack:

```bash
# Prod
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d

# Dev (no GPU)
docker compose -f docker-compose.dev.yml -f docker-compose.observability.yml up -d
```

## Containers

### Loki

- **Image:** `grafana/loki:${LOKI_TAG:-2.9.8}`
- **Container name:** `aims-loki`
- **Port:** `${LOKI_PORT:-3100}:3100`
- **Volume:** `aims-loki-data` (named, persists log index)
- **Config:** `./observability/loki.yml` (mounted read-only)

### Promtail

- **Image:** `grafana/promtail:${PROMTAIL_TAG:-3.4.1}`
- **Container name:** `aims-promtail`
- **Ports:** none exposed to host
- **Volumes:**
  - `./observability/promtail.yml` (read-only)
  - `/var/lib/docker/containers` (read-only) — Docker log files
  - `/var/run/docker.sock` (read-only) — Docker label discovery
- **Config:** `./observability/promtail.yml`

### Grafana

- **Image:** `grafana/grafana:${GRAFANA_TAG:-10.4.3}`
- **Container name:** `aims-grafana`
- **Port:** `${GRAFANA_PORT:-3002}:3000`
- **Volumes:**
  - `aims-grafana-data` (named)
  - `./observability/grafana/provisioning` (read-only) — auto-provisions Loki datasource
  - `./observability/grafana/dashboards` (read-only) — pre-built dashboards

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `LOKI_TAG` | `2.9.8` | Loki image tag |
| `PROMTAIL_TAG` | `3.4.1` | Promtail image tag |
| `GRAFANA_TAG` | `10.4.3` | Grafana image tag |
| `LOKI_PORT` | `3100` | Loki host port |
| `GRAFANA_PORT` | `3002` | Grafana host port |
| `GRAFANA_ADMIN_USER` | `admin` | Grafana admin username |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Grafana admin password — change for non-demo deploys |
| `DOCKER_API_VERSION` | `1.44` | Promtail Docker API version |

See [`.env.example`](../../.env.example).

## Endpoints / interfaces

- **Grafana UI:** `http://<HOST_IP>:3002` — default credentials `admin`/`admin`
- **Loki ingest:** internal only (`http://loki:3100`)

### Log labels

Promtail applies low-cardinality labels only:

| Label | Source |
|---|---|
| `service` | Docker container label / service name |
| `env` | `ENV` env var (e.g. `prod`, `dev`) |
| `level` | Parsed from the JSON `level` field |
| `logger` | Parsed from the JSON `logger` field |

Correlation IDs (`video_id`, `run_id`, `request_id`) are JSON fields inside the log line — query them with Loki's `json` parser in Grafana rather than promoting them to labels.

### Provisioned dashboards

- **AIMS / AIMS Support/Dev Logs** — top-level log view across all services
- **AIMS Service Logs - AIMS Backend** — filtered to `service=aims-backend`
- **AIMS Service Logs - DeepStream vss-rt-cv** — filtered to `service=vss-rt-cv` <!-- TODO: confirm exact label value used by Promtail for this container -->
- **AIMS Service Logs - Redis** — filtered to `service=vss-redis`
- **AIMS Service Logs - Postgres** — filtered to `service=aims-postgres`

Regenerate per-service dashboard JSON after adding or renaming services:

```bash
python3 observability/grafana/generate_service_dashboards.py
docker compose -f docker-compose.yml -f docker-compose.observability.yml restart grafana
```

## Runbook

### Start

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

### Verify Loki ingestion

```bash
curl -s "http://localhost:3100/loki/api/v1/query?query={service=\"aims-backend\"}" | jq .
```

### Tail logs in Grafana

Open `http://<HOST_IP>:3002`, sign in as `admin`/`admin`, navigate to **AIMS / AIMS Support/Dev Logs**.

### Tear down (keeps data volumes)

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml down
```

## Known issues / gotchas

- **Volumes `aims-loki-data` and `aims-grafana-data` are declared in the overlay file**, not in `docker-compose.yml`. Running `docker compose -f docker-compose.yml down -v` will not remove them. Run `docker compose -f docker-compose.yml -f docker-compose.observability.yml down -v` to wipe them.
- **Grafana `admin`/`admin` default** — acceptable for a demo VM behind a firewall; change `GRAFANA_ADMIN_PASSWORD` in `.env` for any internet-accessible deploy.
- **SRE metrics/alerts and OpenSearch indexing are out of scope for v0.** See [V1_PLAN deferred list](../../V1_PLAN.md#deferred-not-blocking-v1-demo).

## Related plan items

- [Phase 9 — Support/dev observability v0](../../V1_PLAN.md#phase-9--supportdev-observability-v0) (items 31–33)
