# DeepStream (vss-rt-cv)

NVIDIA DeepStream perception container. Runs `metropolis_perception_app` (DeepStream 9.0) with RT-DETR / TrafficCamNet (ResNet-50 FP16) for object detection and an IOU tracker. Produces raw detection events in the `mdx-raw` Redis stream that the backend event indexer consumes. This is the only GPU-bound component in the detection path (Cosmos, the other GPU user, only runs on-demand during `POST /analyze`).

## Container / process

- **Image:** `nvcr.io/nvidia/vss-core/vss-rt-cv:${PERCEPTION_TAG}` (tag default `3.1.0`)
- **Compose service name:** `vss-rt-cv`
- **Container name:** `vss-rt-cv`
- **Network:** `vss-net`
- **Dependencies:** `redis` (service_healthy), `sdr` (service_started)
- **Ports:** none exposed to host
- **Volumes:**
  - `${DATA_DIR}/models:/data/models` — TRT engine cache (host bind-mount, `chmod -R 777` required)
  - `${DATA_DIR}/videos:/data/videos` — video files + `current_stream_url.txt`
  - `./deepstream/config:/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app` — perception config, tracker config, msgconv config
  - `./deepstream/init/ds-start.sh:/ds-start.sh` — custom entrypoint
- **Entrypoint:** `/ds-start.sh`
- **GPU:** device `0`, all NVIDIA capabilities
- **Healthcheck:** `tr '\0' ' ' < /proc/1/cmdline | grep -q metropolis_perception_app` every 30 s, 5 m start_period

### What `ds-start.sh` does

1. Copies configs to a writable `/tmp/ds-config/` (DeepStream needs writable paths for relative `config-file=` resolution).
2. Substitutes `REDIS_HOST_PLACEHOLDER` and `STREAM_URI_PLACEHOLDER` in `perception-config.txt`.
3. Checks for the pre-built TRT engine; if absent, checks for the ONNX; if absent, tries `ngc registry model download-version` (note: NGC CLI 403s on signed-URL redirect — pre-stage via bearer REST instead; see runbook).
4. Execs `metropolis_perception_app -c perception-config.txt -m 7 -r 2`.

## Configuration

Required env vars (from [`.env.example`](../../.env.example)):

| Var | Default | Purpose |
|---|---|---|
| `HOST_IP` | — | Forwarded to the perception app |
| `NUM_SENSORS` | `1` | Number of input streams |
| `REDIS_HOST` | `redis` | Redis hostname injected into `perception-config.txt` |
| `REDIS_PORT` | `6379` | Redis port |
| `STREAM_URI` | `rtsp://nvstreamer:30554/placeholder` | Initial stream URI; overridden by `current_stream_url.txt` at startup |
| `PERCEPTION_TAG` | `3.1.0` | Image tag |

### Config files (under `deepstream/config/`)

| File | Purpose |
|---|---|
| `perception-config.txt` | Top-level DeepStream app config; sources, sinks (Redis msgbroker), infer, tracker, msgconv |
| `rtdetr-960x544.txt` | Infer config for TrafficCamNet RT-DETR (ResNet-50, FP16, 960×544) |
| `rtdetr-960x544-labels.txt` | Class labels: car, bicycle, person, road_sign |
| `config_tracker_IOU.yml` | IOU tracker config |
| `dstest5_msgconv_sample_config.txt` | nvmsgconv config (formats objects into the `mdx-raw` pipe-delimited schema) |

### Model

- ONNX: `data/models/trafficcamnet_transformer/resnet50_trafficcamnet_rtdetr.fp16.onnx` (~84 MB)
- TRT engine: `…/resnet50_trafficcamnet_rtdetr.fp16.onnx_b1_gpu0_fp16.engine` (built on first run, ~3.5 min)

## Endpoints / interfaces

### Redis stream produced

| Stream | Key | Format |
|---|---|---|
| `mdx-raw` | `metadata` | JSON string containing `"objects"` array of pipe-delimited 13-part strings: `track_id\|x1\|y1\|x2\|y2\|class\|#\|…\|confidence` |

Example message:
```json
{"metadata": "{\"version\":\"4.0\",\"id\":\"5910\",\"sensorId\":\"0\",\"objects\":[\"177|925.0|264.6|993.6|299.9|bicycle|#|||||||0.66\"]}"}
```

### Stream URI handoff

The backend writes `data/videos/current_stream_url.txt` (e.g. `file:///data/videos/<filename>.mp4`) and restarts this container via Docker socket. On the next start, `ds-start.sh` reads that file and substitutes the URI into the config.

## Runbook

### First boot (cold deploy)

Pre-stage the ONNX before `docker compose up` — NGC CLI 403s on the signed-URL redirect:

```bash
set -a; source .env; set +a
mkdir -p data/models/trafficcamnet_transformer
cd data/models/trafficcamnet_transformer
BASE="https://api.ngc.nvidia.com/v2/org/nvidia/team/tao/models/trafficcamnet_transformer_lite/versions/deployable_resnet50_v2.0/files"
for f in resnet50_trafficcamnet_rtdetr.fp16.onnx labels.txt nvdsinfer_config.yaml; do
  curl -fL -H "Authorization: Bearer $NGC_CLI_API_KEY" -o "$f" "$BASE/$f"
done
cd -

# Fix permissions so the container (uid=1000) can write the engine
chmod -R 777 data/models
```

### Watch TRT compile

```bash
# GPU goes to 5–15 GB usage during compile (~3.5 min, no output)
watch -n5 nvidia-smi

# Engine appears when done:
until [ -f data/models/trafficcamnet_transformer/*.engine ]; do sleep 15; done
echo "engine ready"
```

### Tail logs

```bash
docker logs -f vss-rt-cv
```

### Restart cleanly after a new upload

The backend handles this automatically via Docker socket. Manual:

```bash
docker compose restart vss-rt-cv
```

### Check Redis output

```bash
docker exec vss-redis redis-cli XLEN mdx-raw
docker exec vss-redis redis-cli XREAD COUNT 5 STREAMS mdx-raw 0
```

### Verify `libnvds_redis_proto.so`

```bash
docker exec vss-rt-cv ls /opt/nvidia/deepstream/deepstream/lib/libnvds_redis_proto.so
```

If missing, events won't reach Redis. See comments in `ds-start.sh` for Kafka fallback.

## Known issues / gotchas

- **TRT compile looks like a hang (~3.5 min, no output).** Normal. Watch `nvidia-smi` for GPU utilisation. See [`../gotchas.md`](../gotchas.md#trt-engine-cold-compile-is-35-min-and-looks-like-a-hang).
- **`failed to serialize cuda engine to file` crash-loop.** The container runs as `uid=1000`; host `data/models/` must be world-writable. Fix: `chmod -R 777 data/models`. See [`../gotchas.md`](../gotchas.md#vss-rt-cv-crash-loops-with-failed-to-serialize-cuda-engine-to-file).
- **NGC CLI model download 403.** Pre-stage the ONNX via bearer-token REST (see runbook above). See [`../gotchas.md`](../gotchas.md#vss-rt-cv-exits-trying-to-download-trafficcamnet-from-ngc).
- **`libnvds_redis_proto.so` may be missing.** See README known issues for the Kafka sidecar fallback.
- **IOU tracker ID swaps during occlusion** produce false-positive collision detections. Mitigation in the rule pack: require sustained overlap (≥3 frames) + co-stop. NvDCF swap is a v1.5 item.
- **Pixel-space velocity** depends on camera angle and resolution; thresholds need per-clip tuning. Documented as a known limitation.
- **Crash-loops with placeholder RTSP before first upload.** Expected. The container loops quickly once the engine is cached and stops crashing after a real upload triggers the URI file.

## Related plan items

- [Phase 3 — Backend hardening / `file-loop=0`](../../V1_PLAN.md#phase-3--backend-hardening-for-prod-ish) (burn-list item 4)
- [Phase 5 — GPU VM deploy](../../V1_PLAN.md#phase-5--gpu-vm-deploy--runbook)
- [V1_PLAN risk watch — Rule-pack false positives](../../V1_PLAN.md#risk-watch)
