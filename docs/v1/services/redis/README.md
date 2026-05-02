# Redis

Redis 8.2.2 (Alpine) — the event bus between DeepStream and the backend. DeepStream's `nvmsgbroker` plugin XADDs detection events to the `mdx-raw` stream; the backend event indexer (`event_indexer.py`) drains them via XREADGROUP into Postgres, and the WebSocket broadcaster tails the stream for live clients. Redis data is ephemeral — the volume is not persisted across `docker compose down`.

## Container / process

- **Image:** `redis:8.2.2-alpine`
- **Compose service name:** `redis`
- **Container name:** `vss-redis`
- **Network:** `vss-net` (and via `network_mode: "service:redis"` — the `sdr` service shares this container's network namespace so `localhost:6379` resolves correctly for SDR)
- **Dependencies:** none
- **Ports:** `6379:6379` (Redis), `4001:4001` (SDR, which runs in the redis network namespace)
- **Volumes:** none (data is ephemeral)
- **Healthcheck:** `redis-cli ping` every 10 s, 5 s start_period

## Configuration

No custom Redis configuration file is mounted. Default Redis settings apply.

Backend connection env vars (set on the `backend` service, not `redis`):

| Var | Default |
|---|---|
| `REDIS_HOST` | `redis` |
| `REDIS_PORT` | `6379` |

## Endpoints / interfaces

### Streams

| Stream | Producer | Consumer |
|---|---|---|
| `mdx-raw` | `vss-rt-cv` (DeepStream `nvmsgbroker` → `libnvds_redis_proto.so`) | `event_indexer.py` via XREADGROUP `indexer/indexer-1`; `events.py` WS broadcaster via XREAD BLOCK |

### Keys

| Key | Usage |
|---|---|
| `current_video_id` | Backend sets this after each upload so the indexer routes events to the correct `uploads` row |

## Runbook

### Ad-hoc inspection

```bash
docker exec vss-redis redis-cli XLEN mdx-raw
docker exec vss-redis redis-cli XREAD COUNT 5 STREAMS mdx-raw 0
docker exec vss-redis redis-cli GET current_video_id
```

### Tail logs

```bash
docker logs -f vss-redis
```

### Restart cleanly

```bash
docker compose restart redis
# Note: mdx-raw stream contents are lost on restart
```

### Flush the stream

```bash
docker exec vss-redis redis-cli DEL mdx-raw
```

## Known issues / gotchas

- **`mdx-raw` is ephemeral.** If Redis restarts, the stream is lost. The Postgres `events` table retains everything already indexed. Events not yet drained by the indexer at restart time are lost.
- **Port 4001 is SDR's port**, exposed via the Redis container because SDR uses `network_mode: "service:redis"`. The Redis service itself does not listen on 4001.
- **`redis-commander` removed from prod compose.** Use `docker exec vss-redis redis-cli` for ad-hoc inspection.

## Related plan items

- [Phase 3 — Backend hardening (drop redis-commander)](../../../V1_PLAN.md#phase-3--backend-hardening-for-prod-ish) (burn-list item 7)
