# AIMS Docs — Navigation Index

This directory contains operational documentation for SSI AIMS: per-service references, deploy runbooks, and gotchas. The tree is:

```
docs/
  README.md             this file — start here
  architecture.md       system architecture, data flows, service inventory, schema
  gotchas.md            cold-deploy surprises and known failure modes
  deploy/
    deploy.md           GPU VM deploy runbook (Brev / Ubuntu)
    reverse-proxy.md    nginx reverse-proxy + firewall handoff notes
  services/
    README.md           services overview table
    frontend/README.md
    backend/README.md
    deepstream/README.md
    cosmos/README.md
    postgres/README.md
    redis/README.md
    nvstreamer/README.md
    sdr/README.md
    observability/README.md
```

---

## If you are an agent, start here

Read [`../AGENTS.md`](../AGENTS.md) first — it has the repo map, vocabulary lock (Event / Incident / Scenario), UI conventions (shadcn-only), and backend conventions (raw SQL, asyncpg, no ORM).

Then check [`/plan.md`](/plan.md) for the burn list and locked decisions. The "Services" table near the top links directly to each service doc.

For what is actually running on `main` right now: [`../CURRENT_STATE.md`](../CURRENT_STATE.md).

---

## Plan and orientation

| Doc | Purpose |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | Repo map, conventions, run commands — read before editing |
| [`../README.md`](../README.md) | User-facing setup and run flow |
| [`architecture.md`](./architecture.md) | System architecture, data flows, service inventory, schema |
| [`/plan.md`](/plan.md) | Roadmap, phases, burn list, locked decisions |
| [`../CURRENT_STATE.md`](../CURRENT_STATE.md) | Snapshot of what is running on `main` |
| [`../FUTURE_STATE_POT_ARCHIVED.md`](../FUTURE_STATE_POT_ARCHIVED.md) | DeepStream config reference from the POT era (archived, still accurate) |

---

## Per-service docs

Each directory can grow to hold runbooks, ADRs, and screenshots specific to that service.

| Service | Compose name | Description |
|---|---|---|
| [frontend/](./services/frontend/README.md) | `frontend` | Next.js 15 UI — uploads, timeline scrubber, incidents |
| [backend/](./services/backend/README.md) | `backend` | FastAPI — upload handler, event indexer, incident worker, VLM orchestration |
| [deepstream/](./services/deepstream/README.md) | `vss-rt-cv` | NVIDIA DeepStream perception — RT-DETR / TrafficCamNet, IOU tracker, `mdx-raw` producer |
| [cosmos/](./services/cosmos/README.md) | `cosmos` | Cosmos-Reason2-2B NIM — VLM incident validation (Phase 8) |
| [postgres/](./services/postgres/README.md) | `postgres` | Postgres 16 — persistent store for uploads, events, incidents |
| [redis/](./services/redis/README.md) | `redis` | Redis 8 — `mdx-raw` stream bus between DeepStream and the backend |
| [nvstreamer/](./services/nvstreamer/README.md) | `nvstreamer` | NVStreamer 3.1.0 — video ingest sidecar (currently bypassed in v1) |
| [sdr/](./services/sdr/README.md) | `sdr` | Stream Discovery & Registration — cosmetic in upload-only v1 |
| [observability/](./services/observability/README.md) | Loki / Promtail / Grafana | Optional support/dev log UI overlay |

Also see [services/README.md](./services/README.md) for the overview table with Compose service names.

---

## Deploy

| Doc | Purpose |
|---|---|
| [deploy/deploy.md](./deploy/deploy.md) | Cold-deploy runbook for a fresh GPU VM (Brev / Ubuntu) |
| [deploy/reverse-proxy.md](./deploy/reverse-proxy.md) | nginx reverse-proxy and firewall configuration handoff notes |

---

## Gotchas

[gotchas.md](./gotchas.md) — things that have bitten us during cold deploys or rebuilds. Skim before a fresh setup.
