# SSI AIMS — Deploy Runbook

Cold-deploy on a fresh GPU VM. Validated 2026-04-30 on Brev A6000 (driver 580, CUDA 13). Allow ~45 min end-to-end (Phase 8 Cosmos weight load adds ~10–15 min on first boot).

If something doesn't work, [`gotchas.md`](gotchas.md) has the symptom → fix table.

---

## 0. Prerequisites

- Linux GPU host. **Ampere or newer**, ≥ 24 GB VRAM, NVIDIA driver ≥ 580.
  - Phase 8 (VLM): DeepStream ~3 GB + Cosmos-Reason2-2B ~5–6 GB BF16 ≈ 9 GB peak. A6000 48 GB has comfortable headroom.
- 250 GB disk free (images + model + sample clips + Cosmos weight cache ~15 GB).
- Outbound HTTPS to `nvcr.io` and `api.ngc.nvidia.com`.
- An NGC API key — see [NGC API Keys](https://org.ngc.nvidia.com/setup/api-keys).
- Sudo on the host.

```bash
nvidia-smi               # confirm GPU + driver
df -h /                  # confirm disk
```

---

## 1. Bootstrap the host

Installs Docker + Compose v2, NVIDIA Container Toolkit, NGC CLI:

```bash
git clone https://github.com/<org>/aims.git ~/aims
cd ~/aims
./scripts/vm_setup.sh        # idempotent, ~3 min
newgrp docker                 # or log out/in so docker group applies
```

Verify:

```bash
docker --version
docker compose version
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
ngc --version
```

---

## 2. Configure environment

```bash
cp .env.example .env
$EDITOR .env
```

Required keys:

| Key | Value |
|---|---|
| `NGC_CLI_API_KEY` | NGC API key from step 0 |
| `HOST_IP` | `$(ip route get 1.1.1.1 \| awk '{print $7; exit}')` |
| `DATA_DIR` | `./data` |
| `NUM_SENSORS` | `1` |
| `PERCEPTION_TAG` / `NVSTREAMER_TAG` / `SDR_TAG` | `3.1.0` |
| `POSTGRES_PASSWORD` | choose a password (default `aims` is fine for demo) |
| `DATABASE_URL` | `postgresql://aims:<POSTGRES_PASSWORD>@postgres:5432/aims` |
| `VLM_ENABLED` | `false` to skip Cosmos validation; `true` to enable Phase 8 |

Log in to NGC's container registry:

```bash
echo "$NGC_CLI_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
```

---

## 3. Pre-stage the TrafficCamNet model bundle

`ds-start.sh` will try `ngc registry model download-version` if the bundle is missing. **That call 403s** on the signed-URL redirect to `xfiles.ngc.nvidia.com`. Pre-stage the three files via bearer-token REST instead:

```bash
set -a; source .env; set +a
mkdir -p data/models/trafficcamnet_transformer
cd data/models/trafficcamnet_transformer

BASE="https://api.ngc.nvidia.com/v2/org/nvidia/team/tao/models/trafficcamnet_transformer_lite/versions/deployable_resnet50_v2.0/files"

for f in resnet50_trafficcamnet_rtdetr.fp16.onnx labels.txt nvdsinfer_config.yaml; do
  curl -fL -H "Authorization: Bearer $NGC_CLI_API_KEY" -o "$f" "$BASE/$f"
done

cd -
```

Total ~84 MB.

---

## 4. Fix bind-mount permissions

The `vss-rt-cv` container runs as `uid=1000(triton-server)`. The host model dir inherits the cloning user's UID with mode 755, so TRT can't serialize the compiled engine. Without this fix the container crash-loops with `failed to serialize cuda engine to file`.

```bash
chmod -R 777 data/models
mkdir -p data/videos && chmod 777 data/videos
```

> Day-2 item: moving the engine cache to a named Docker volume would retire this step.

---

## 5. Bring the stack up

```bash
docker compose up -d --build
docker compose ps
```

Expected services: `aims-postgres`, `vss-redis`, `vss-nvstreamer`, `vss-sdr`, `vss-rt-cv`, `vss-backend`, `vss-frontend`, `aims-cosmos`.

> If `VLM_ENABLED=false` you can omit the cosmos service entirely: `docker compose up -d --build --scale cosmos=0`. The backend will still start and VLM results will be marked `skipped`.

---

## 6. Wait for first-boot weight loads

### TRT engine (DeepStream)

First boot of `vss-rt-cv` builds the FP16 engine from the ONNX. **~3.5 minutes with no progress output** — this is normal, do not assume it has hung.

Watch the file appear:

```bash
until [ -f data/models/trafficcamnet_transformer/resnet50_trafficcamnet_rtdetr.fp16.onnx_b1_gpu0_fp16.engine ]; do
  echo "compiling..." ; sleep 15
done
echo "engine ready"
```

The container will then crash-loop on a placeholder RTSP source until step 7 — that is expected. Each loop is fast (seconds) once the engine is cached.

### Cosmos-Reason2-2B weight load (Phase 8 only)

The `aims-cosmos` container loads ~15 GB of model weights on first start. **Allow 10–15 minutes** before the healthcheck passes. The `aims-cosmos-cache` named volume persists the weights so subsequent restarts skip the download (~60 s).

Watch it become ready:

```bash
docker logs -f aims-cosmos   # wait for "Application startup complete"
# or poll the health endpoint:
until curl -fsS http://localhost:8000/v1/health/ready; do sleep 15; done
echo "cosmos ready"
```

GPU co-residency note: DeepStream and Cosmos share GPU 0. DeepStream uses ~3 GB for inference; Cosmos-Reason2-2B BF16 uses ~5–6 GB. Combined peak is well under the A6000's 48 GB. VLM validation only runs during the `analyze` call (not during video processing), so there is no simultaneous GPU contention in normal operation.

---

## 7. Smoke test

```bash
# Place a sample clip
mkdir -p data/videos
cp <local clip>.mp4 data/videos/

# Upload via the API (or use the UI at http://$HOST_IP:3000)
curl -X POST "http://localhost:8080/api/upload" \
  -F "file=@data/videos/<clip>.mp4" \
  -F "prompt=smoke test"
```

Within ~10 s the backend writes `data/videos/current_stream_url.txt`, restarts `vss-rt-cv`, and the pipeline starts processing. Verify:

```bash
docker exec vss-redis redis-cli XLEN mdx-raw         # > 0 within 30 s
docker exec aims-postgres psql -U aims -d aims -t -c \
  "SELECT count(*), count(DISTINCT track_id) FROM events;"
```

For a 149 s 720p clip at 15 fps you should see ~10 k–20 k events / 30–80 tracks across the four classes (car, person, bicycle, road_sign).

---

## 8. Acceptance checks

| # | Check | How |
|---|---|---|
| A1 | Frontend loads at `http://$HOST_IP:3000` | browser |
| A2 | Health endpoint | `curl http://localhost:8080/healthz` → `200` |
| A3 | Upload returns a `video_id` | step 7 |
| A4 | Events flow into Postgres | `SELECT count(*) FROM events` increases |
| A5 | Track summary endpoint | `curl /api/uploads/<id>/events?group=tracks` returns rows |
| A6 | Pipeline terminates (no loop) | `vss-rt-cv` log shows `EOS`/`Quitting` after clip duration |
| A7 | Restart preserves engine cache | `docker compose restart vss-rt-cv`; second boot < 30 s |
| A8 | Branding visible | "SSI AIMS" in tab title, sidebar logo |

---

## 9. Day-2 operations

| Task | Command |
|---|---|
| Tail pipeline | `docker logs -f vss-rt-cv` |
| Tail backend | `docker logs -f vss-backend` |
| Reset all uploads | `curl -X POST http://localhost:8080/api/reset` |
| Drop a single upload | `curl -X DELETE http://localhost:8080/api/uploads/<video_id>` |
| Restart stack cleanly | `docker compose restart` |
| Full teardown | `docker compose down`  (keeps `data/`) |
| Wipe everything | `docker compose down -v && rm -rf data/videos data/models/*/*.engine` |

---

## Troubleshooting quick links

- `frontend` build fails on `node_modules` collision → see [gotchas: frontend build](gotchas.md#frontend-build-fails-with-cannot-replace-to-directory--node_modules-with-file)
- `vss-rt-cv` exits with engine-serialize error → step 4 above (chmod)
- Backend `CannotConnectNowError` on first boot → expected, recovers; tracked under burn-list item 5
- `Stream Not Found (404)` from RTSP source in `vss-rt-cv` logs → expected before any upload; do step 7

For anything else, check [`docs/gotchas.md`](gotchas.md).
