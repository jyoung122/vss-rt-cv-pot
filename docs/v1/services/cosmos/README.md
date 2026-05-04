# Cosmos (VLM validator — local NIM)

Self-hosted NVIDIA Cosmos-Reason2 NIM container. One of two VLM provider options behind the `VLM_PROVIDER` env (the other is `openai`). When `VLM_PROVIDER=cosmos`, `vlm_validator.py` extracts a short video clip via ffmpeg and POSTs it base64-encoded to this container's OpenAI-compatible chat completions API. The VLM either confirms, rejects, or marks the incident as uncertain, and provides a natural-language explanation. The pipeline runs without it when `VLM_ENABLED=false` (or when `VLM_PROVIDER=openai`).

**Compose profile.** This service is gated behind `profiles: [gpu]`. Plain `docker compose up` does NOT bring it up — that lets `VLM_PROVIDER=openai` deployments skip the 30 GB NIM image entirely. Bring it up explicitly:

```bash
docker compose --profile gpu up -d
```

For split-deploy topologies (app on Vercel/Render + Neon, GPU on a separate box), point the backend at the remote Cosmos host via `COSMOS_URL=https://gpu-host.example/...` — there is no compose-internal coupling between the `backend` and `cosmos` services.

**Model swap.** The model id is env-driven via `COSMOS_MODEL` (default `nvidia/cosmos-reason2-2b`). Switching to the 8B model is a config-only change: `COSMOS_MODEL=nvidia/cosmos-reason2-8b` and update the `image:` field accordingly. No backend code changes.

## Container / process

- **Image:** `nvcr.io/nim/nvidia/cosmos-reason2-2b:latest` (or 8b)
- **Compose service name:** `cosmos`
- **Container name:** `aims-cosmos`
- **Network:** `vss-net`
- **Profile:** `gpu` — must be explicitly enabled
- **Dependencies:** none (backend connects to it asynchronously after startup)
- **Ports:** `8000:8000` (host:container)
- **Volumes:**
  - `aims-cosmos-cache:/opt/nim/.cache` — named volume; persists model weights (~15 GB) across restarts
  - `${DATA_DIR}/videos:/data/videos:ro` — read-only access to uploaded video files for clip extraction
  - `${DATA_DIR}/incidents:/data/incidents` — clip output directory (used if VLM reads file paths rather than base64)
- **GPU:** device `0`, all NVIDIA capabilities (shares GPU 0 with `vss-rt-cv`)
- **Healthcheck:** `curl -fsS http://localhost:8000/v1/health/ready` every 30 s, **10 m start_period**

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `NGC_API_KEY` | `${NGC_CLI_API_KEY}` | NGC auth for image pull |
| `NIM_CACHE_PATH` | `/opt/nim/.cache` | Weight cache directory (must match the `aims-cosmos-cache` volume mount) |
| `VLM_ENABLED` | `false` | Set in the **backend** env, not here. Controls whether `vlm_validator.py` fires. |
| `VLM_PROVIDER` | `cosmos` | Set in the **backend** env. Selects this provider over the OpenAI alternative. |
| `COSMOS_URL` | `http://cosmos:8000` | Set in the **backend** env; can point at a remote GPU host for split deploys. |
| `COSMOS_MODEL` | `nvidia/cosmos-reason2-2b` | Set in the **backend** env. Written to the `vlm_model` column for each verdict. |

Pull the image before first `docker compose up`:

```bash
echo "$NGC_CLI_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
docker compose pull cosmos
```

## Endpoints / interfaces

Cosmos exposes an OpenAI-compatible chat completions API. The backend calls it as:

```
POST http://cosmos:8000/v1/chat/completions
```

with a base64-encoded video payload and a structured JSON verdict prompt. The backend strips `<think>` tags from the response before parsing.

Health endpoint used by the Compose healthcheck:

```
GET http://cosmos:8000/v1/health/ready
```

## Runbook

### First boot

Allow **10–15 minutes** for the container to download and load ~15 GB of weights. The Compose healthcheck `start_period: 10m` prevents it from being marked unhealthy during this window.

```bash
docker logs -f aims-cosmos   # wait for "Application startup complete"

# Poll the health endpoint:
until curl -fsS http://localhost:8000/v1/health/ready; do sleep 15; done
echo "cosmos ready"
```

Subsequent cold starts (weights cached in `aims-cosmos-cache`) take ~60 s.

### Tail logs

```bash
docker logs -f aims-cosmos
```

### Skip Cosmos entirely

```bash
# In .env:
VLM_ENABLED=false

# Or exclude the service from compose:
docker compose up -d --scale cosmos=0
```

When `VLM_ENABLED=false`, the backend sets `vlm_status='skipped'` for all incidents without contacting Cosmos.

### Restart cleanly

```bash
docker compose restart cosmos
# Allow ~60 s for the cached weight load before /v1/health/ready returns 200
```

### GPU co-residency

Cosmos-Reason2-2B BF16 uses ~5–6 GB VRAM. DeepStream uses ~3 GB. Combined peak (~9 GB) is well under the A6000's 48 GB. VLM validation runs only during `POST /api/uploads/:id/analyze`, not during video processing, so there is no simultaneous GPU contention in normal operation.

## Known issues / gotchas

- **First-boot healthcheck fails for 10–15 min.** This is normal — weight download in progress. The `start_period: 10m` covers it. See [`../../gotchas.md`](../../gotchas.md#aims-cosmos-healthcheck-fails-for-1015-minutes-on-first-boot).
- **`POST /analyze` returns VLM errors after Cosmos is healthy.** Most likely the API rejected the base64 video payload. Diagnose with `docker logs vss-backend | grep vlm_validator` and `docker logs aims-cosmos`. Quick workaround: `VLM_ENABLED=false`. See [`../../gotchas.md`](../../gotchas.md#aims-cosmos-is-healthy-but-post-analyze-returns-vlm-errors).
- **VLM hallucination risk.** Cosmos may confidently confirm incidents that didn't happen. The UI always renders rule confidence alongside the VLM pill — a VLM-only verdict is never presented without rule context.
- **Ampere (A6000) support.** NVIDIA's tested platforms for Cosmos-Reason2-2B are Hopper and Blackwell. Ampere (A6000) was validated in practice (Phase 8 spike skipped; went straight to implementation #25–30 and tests passed). See [V1_PLAN risk watch](../../../V1_PLAN.md#risk-watch).

## Related plan items

- [Phase 8 — Cosmos-Reason2-2B VLM validation](../../../V1_PLAN.md#phase-8--cosmos-reason2-2b-vlm-validation-phase-b) (items 24–30)
- [Locked decision D12 — Cosmos-Reason2-2B self-hosted via NIM](../../../V1_PLAN.md#locked-decisions)
- [Locked decision D13 — GPU plan](../../../V1_PLAN.md#locked-decisions)
