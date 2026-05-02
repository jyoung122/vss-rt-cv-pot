# SDR (Stream Discovery & Registration)

NVIDIA VSS Core SDR — the stream discovery and registration service. Manages stream source registration and routing between NVStreamer and DeepStream. In v1 upload-only mode, the SDR registration call that the backend makes after each upload is **cosmetic**: the actual perception path uses a `file://` URI written directly to `current_stream_url.txt`, so SDR registration failure does not block detection.

## Container / process

- **Image:** `nvcr.io/nvidia/vss-core/sdr:${SDR_TAG}` (tag default `3.1.0`)
- **Compose service name:** `sdr`
- **Container name:** `vss-sdr`
- **Network:** `network_mode: "service:redis"` — SDR assumes a Kubernetes pod layout with Redis colocated; it binds to `localhost:6379`. Sharing the Redis container's network namespace makes this work without Kubernetes.
- **Dependencies:** `nvstreamer` (service_started), `redis` (service_healthy)
- **Ports:** `4001` — exposed via the `redis` service container (not a separate host port mapping)
- **Volumes:**
  - `/var/run/docker.sock:/var/run/docker.sock` — SDR may use Docker events for stream lifecycle management
- **Healthcheck:** none defined

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `NVSTREAMER_URL` | `http://nvstreamer:30000` | NVStreamer management API |
| `SDR_TAG` | `3.1.0` | Image tag |

`SDR_URL` (`http://sdr:4001`) is passed to the backend. The backend's `sdr.py` module sends stream registration requests here after each upload.

## Known issues / gotchas

- **SDR DNS error on cold start** (`Temporary failure in name resolution`). Observed once (2026-04-30) during the e2e validation. Does not block detection because SDR registration is not in the active perception path. See [`../../gotchas.md`](../../gotchas.md#backend-logs-error-registering-stream-with-sdr).
- **SDR API is partially documented.** The expected request body lives in `backend/app/sdr.py`. If stream registration fails consistently, check `docker compose logs sdr`.
- **`network_mode: "service:redis"` quirk.** SDR has no independent network entry on `vss-net`. Reaching SDR from other containers requires going through the Redis container's IP on port `4001`. The compose exposes `4001` on the `redis` service for this reason.

## Related plan items

- [Locked decision D4 — Upload-only; RTSP deferred](../../../V1_PLAN.md#locked-decisions)
