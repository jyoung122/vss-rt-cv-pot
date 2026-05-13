# AWS deployment — single-host (current)

> **2026-05-12 merge.** The earlier "AWS edge (t3.small Caddy) + Brev L40S GPU" split was retired when GPU quota landed on AWS. Everything now runs on one AWS GPU instance. The split-deploy artifacts (split tailnet, two-host Caddy, Brev-side compose) are gone from `main`; consult git history (`git log --before=2026-05-12 -- deploy/aws-poc/SPLIT-DEPLOY.md`) for the previous design.

## Current architecture

```
┌─────────────────────────────────────────────────────────────────┐
│        AWS EC2 g6.xlarge (us-west-2)  —  single-host stack       │
│  ─────────────────────────────────────────────────────────────  │
│  • 1× L4 24 GB GPU (was g6e/L40S — fell back due to capacity)    │
│  • Ubuntu 22.04 DLAMI; driver 580; NVIDIA container toolkit       │
│  • Caddy → Next.js :3000, FastAPI :8080, Supabase Kong :8000      │
│  • docker compose -f docker-compose.yml \                         │
│                  -f docker-compose.supabase.yml up -d             │
│  • mediamtx (RTSP relay) + NVStreamer + vss-rt-cv all on vss-net  │
│                                                                   │
│  Public DNS: aims.synch-solutions.com (Route 53 → EIP)            │
│  Cost: ~$0.85/hr × 11h/day on schedule                            │
└─────────────────────────────────────────────────────────────────┘
```

The frontend bundle hits Supabase via the same origin (`window.location.origin`) so the `NEXT_PUBLIC_SUPABASE_URL` build-arg is set to `http://kong:8000` (server-side Docker DNS) and Next.js rewrites `/auth/v1/*` → kong for browser traffic.

## Compose overlay layout

| File | Role |
|---|---|
| `docker-compose.yml` | redis, nvstreamer, sdr, mediamtx, vss-rt-cv, backend, frontend |
| `docker-compose.supabase.yml` | db, auth (gotrue), kong, storage, studio, minio, imgproxy |
| `docker-compose.observability.yml` | Loki + Promtail + Grafana (:3002) — optional |

The Supabase overlay's `db` service is the **only** Postgres in this deploy (the standalone `vss-postgres` container is gone). A first-boot init script at `supabase/db/init/99-roles.sql` seeds passwords for the supabase-* internal roles from `${POSTGRES_PASSWORD}` (the upstream image locks those roles, so `ALTER USER` from outside fails).

## Bring-up cheat sheet

```bash
# 1. provision
./00-config.sh               # set INSTANCE_TYPE, AMI filter, SCHEDULE_*
./01-launch.sh               # provisions VPC bits + launches instance
./02-eip.sh                  # allocates + associates EIP

# 2. deploy (on the box, via ssh)
git clone https://github.com/jyoung122/vss-rt-cv-pot.git aims
cd aims
cp .env.example .env         # fill NGC_CLI_API_KEY, POSTGRES_PASSWORD, JWT_SECRET
docker compose -f docker-compose.yml -f docker-compose.supabase.yml up -d --build

# 3. DNS + TLS
sudo systemctl reload caddy   # Caddyfile at /etc/caddy/Caddyfile

# 4. schedule auto start/stop
./04-schedule.sh
```

See [`RUNBOOK.md`](RUNBOOK.md) for the full step-by-step including pre-flight, DNS delegation, and teardown.

## What changed vs the old split

- **Caddy** moved from t3.small to the GPU box; one Caddyfile, one cert.
- **Tailscale** removed — no cross-host networking needed.
- **Supabase** overlay added; the previous standalone `postgres` service is retired.
- **`NEXT_PUBLIC_SUPABASE_URL`** is `http://kong:8000` (server-side); browser uses same-origin rewrites.
- **No more `current_stream_url.txt` / docker-socket restart** — see [`../../docs/state/log/2026-05-12-f2-diff-plan.md`](../../docs/state/log/2026-05-12-f2-diff-plan.md).
