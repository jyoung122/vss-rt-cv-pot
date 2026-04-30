# SSI AIMS — AI Monitoring System

> The repository directory is still `vss-rt-cv-pot/` and will be renamed to `aims/` after Phase 1–3 of the v1 ship plan land. See [`../V1_PLAN.md`](../V1_PLAN.md).

Real-time computer vision monitoring: upload video → DeepStream perception (RT-DETR / TrafficCamNet) → detection + tracking events stream to Redis → WebSocket → browser overlay + event feed.

**Original POT description (still accurate technically):** end-to-end proof of concept: upload video → NVStreamer replays as RTSP → vss-rt-cv (DeepStream with RT-DETR/TrafficCamNet) runs perception → detection events stream to Redis Streams → WebSocket → browser event feed.

**Target:** Brev RTX PRO 6000 BW instance. Works on any Docker+GPU-enabled host.

---

## Prerequisites

- Docker + Docker Compose v2
- NVIDIA Container Toolkit installed and GPU accessible (`nvidia-smi` should work)
- NGC CLI installed and authenticated (`ngc config set`)
- NGC API key with access to `nvcr.io/nvidia/vss-core/*`
- Docker logged in to NGC:
  ```bash
  echo $NGC_CLI_API_KEY | docker login nvcr.io -u '$oauthtoken' --password-stdin
  ```

---

## Clone and Configure

```bash
git clone <repo-url> vss-rt-cv-pot
cd vss-rt-cv-pot
cp .env.example .env
```

Edit `.env`:

```bash
NGC_CLI_API_KEY=<your-api-key>
HOST_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')  # Auto-detect LAN IP
DATA_DIR=./data  # Creates ./data/videos and ./data/models
```

Make the DeepStream entrypoint executable:

```bash
chmod +x deepstream/init/ds-start.sh
```

---

## Get Sample Videos

```bash
ngc registry resource download-version nvidia/vss-developer/dev-profile-sample-data:3.0.0

mkdir -p data/videos
tar -xf dev-profile-sample-data_v3.0.0/dev-profile-sample-data.tar.gz -C data/videos/
rm -rf dev-profile-sample-data_v3.0.0
```

---

## Start the Stack

```bash
docker compose up -d
```

**First run takes 2-5 minutes.** The `vss-rt-cv` container downloads the TrafficCamNet model from NGC and compiles a TensorRT engine on first boot. Subsequent starts are fast (engine cached in `data/models/`).

Watch logs:

```bash
docker compose logs -f vss-rt-cv
# Wait for: "Starting DeepStream perception pipeline..."
```

---

## Use It

1. Open `http://<HOST_IP>:3000`
2. Click **Upload** and select a video from `data/videos/`
3. Video plays on the left; detection events stream in on the right within seconds

Debug Redis directly:

```bash
docker compose exec redis redis-cli XLEN mdx-raw
docker compose exec redis redis-cli XREAD COUNT 5 STREAMS mdx-raw 0
```

Redis Commander (stream UI): `http://<HOST_IP>:8081`

---

## Stop

```bash
docker compose down
```

State is ephemeral — Redis clears on restart. Video files and cached models in `./data/` persist.

---

## Known Issues and Risks

**TensorRT engine compile (~60-120s on first run)**

Normal. The RT-DETR ONNX model compiles to TensorRT on first boot. Watch `docker compose logs -f vss-rt-cv` — wait for "Starting DeepStream" before uploading.

**`libnvds_redis_proto.so` may be missing**

The vss-rt-cv container ships with Kafka as the default message broker. If the Redis proto library is absent, detection events won't reach the browser. Verify:

```bash
docker compose exec vss-rt-cv ls /opt/nvidia/deepstream/deepstream/lib/libnvds_redis_proto.so
```

If missing, see `deepstream/init/ds-start.sh` comments for fallback options (Kafka sidecar, file sink).

**NVStreamer discovery delay**

After upload, NVStreamer takes 2-5 seconds to publish the RTSP stream. The backend polls NVStreamer before registering with SDR — delayed event starts are normal.

**SDR API**

SDR's `stream/add` endpoint is partially documented. If stream registration fails, check:

```bash
docker compose logs sdr
```

Expected request body is in `backend/app/sdr.py`.

---

## Architecture

```
Browser (Next.js :3000)
    │  upload .mp4/.mkv
    ▼
FastAPI backend (:8080)
    │  saves → NVStreamer watched dir
    │  polls NVStreamer until stream live
    │  registers stream with SDR
    ▼
NVStreamer (:31554 RTSP)
    │  loops video as RTSP
    ▼
vss-rt-cv / DeepStream (GPU)
    │  RT-DETR TrafficCamNet inference
    │  XADD mdx-raw → Redis
    ▼
Redis Streams (:6379)
    │  XREAD BLOCK → FastAPI WS
    ▼
Browser event feed (last 100 detections)
```
