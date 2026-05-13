# AIMS Service Documentation

Per-service reference for SSI AIMS. Each file covers the container/process definition, configuration, endpoints or interfaces, runbook, and known issues for one service.

For the cross-service roadmap and burn list, see [`../V1_PLAN.md`](../V1_PLAN.md). For the full deploy walkthrough, see [`../deploy/deploy.md`](../deploy/deploy.md).

---

## Services

| File | Compose service | Description |
|---|---|---|
| [frontend/](./frontend/README.md) | `frontend` | Next.js 15 UI — uploads, timeline scrubber, incidents |
| [backend/](./backend/README.md) | `backend` | FastAPI — upload handler, event indexer, incident worker, VLM orchestration |
| [deepstream/](./deepstream/README.md) | `vss-rt-cv` | DeepStream / metropolis_perception_app — RT-DETR detection + IOU tracker |
| [nvstreamer/](./nvstreamer/README.md) | `vss-nvstreamer` | NVStreamer 3.1.0 — per-sensor RTSP registration (`/api/v1/sensor/*`). File-streamer adapter broken upstream; uploads use the RTSP path via mediamtx |
| [sdr/](./sdr/README.md) | `vss-sdr` | Stream Discovery & Registration — present, cosmetic in current path (`nvds_rest_server` on vss-rt-cv:9000 is the source-add endpoint) |
| mediamtx | `vss-mediamtx` | RTSP relay; one ffmpeg publisher per upload pushes to `rtsp://mediamtx:8554/<video_id>` |
| [cosmos/](./cosmos/README.md) | `cosmos` | Cosmos-Reason2-2B NIM — VLM incident validation (Phase 8) |
| [postgres/](./postgres/README.md) | `supabase-db` | Postgres (Supabase overlay) — persistent store for uploads/events/incidents + Supabase auth schema. The standalone `vss-postgres` service is retired. |
| [redis/](./redis/README.md) | `redis` | Redis 8 — `mdx-raw` stream bus between DeepStream and the backend |
| [observability/](./observability/README.md) | Loki / Promtail / Grafana | Optional support/dev log UI overlay |
