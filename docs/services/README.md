# AIMS Service Documentation

Per-service reference for SSI AIMS. Each file covers the container/process definition, configuration, endpoints or interfaces, runbook, and known issues for one service.

For the cross-service roadmap and burn list, see [`../../V1_PLAN.md`](../../V1_PLAN.md). For the full deploy walkthrough, see [`../deploy/deploy.md`](../deploy/deploy.md).

---

## Services

| File | Compose service | Description |
|---|---|---|
| [frontend.md](./frontend.md) | `frontend` | Next.js 15 UI — uploads, timeline scrubber, incidents |
| [backend.md](./backend.md) | `backend` | FastAPI — upload handler, event indexer, incident worker, VLM orchestration |
| [deepstream.md](./deepstream.md) | `vss-rt-cv` | DeepStream / metropolis_perception_app — RT-DETR detection + IOU tracker |
| [nvstreamer.md](./nvstreamer.md) | `nvstreamer` | NVStreamer 3.1.0 — video ingest sidecar (currently bypassed) |
| [sdr.md](./sdr.md) | `sdr` | Stream Discovery & Registration — route management layer |
| [cosmos.md](./cosmos.md) | `cosmos` | Cosmos-Reason2-2B NIM — VLM incident validation (Phase 8) |
| [postgres.md](./postgres.md) | `postgres` | Postgres 16 — persistent store for uploads, events, incidents |
| [redis.md](./redis.md) | `redis` | Redis 8 — `mdx-raw` stream bus between DeepStream and the backend |
| [observability.md](./observability.md) | Loki / Promtail / Grafana | Optional support/dev log UI overlay |
