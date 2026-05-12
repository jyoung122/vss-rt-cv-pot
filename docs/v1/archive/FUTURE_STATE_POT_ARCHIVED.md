# VSS-RT-CV POT — Future State (ARCHIVED)

> **ARCHIVED** — predates the "POT becomes the app" pivot. Useful as DeepStream
> reference material; not a description of the current direction. See `README.md`
> and `../V1_PLAN.md` for the current state and roadmap.

Goal: extract the working perception pipeline as a service that plugs into a larger app, drop the demo scaffolding, and add the analytics needed for accident detection.

The environment that built this POT will be torn down — only this repo remains. The first half of this document is **reference material an AI agent or engineer needs to bootstrap an RT-CV component in another application** without re-discovering everything from scratch. The second half is the phased plan for evolving this code into that component.

---

# Part 1 — Reference for building an RT-CV component using this repo as a starting point

## TL;DR
- **Pipeline shape:** input video (file or RTSP) → DeepStream perception (`metropolis_perception_app` inside `nvcr.io/nvidia/vss-core/vss-rt-cv:3.1.0`) → message broker → Redis Stream `mdx-raw` → consumer.
- **Use `metropolis_perception_app` as the entrypoint, not `deepstream-app`.** The standard `deepstream-app` will not emit detection events to a message broker without C-code modifications.
- **The DeepStream model is RT-DETR but the parser symbol is `NvDsInferParseCustomDDETRTAO`** — that's how NGC ships it. Don't switch to a different parser.
- **The authoritative config for the model's nvinfer settings is `data/models/trafficcamnet_transformer/nvdsinfer_config.yaml`** (downloaded with the model from NGC). The repo's `deepstream/config/rtdetr-960x544.txt` is derived from it.
- **The repo's `deepstream/` directory + the ONNX model is everything you need** to bring up perception in another stack. `backend/` and `frontend/` are demo glue.

## Architecture & data flow

```
input source (file:// or rtsp://)
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  vss-rt-cv container (nvcr.io/nvidia/vss-core/vss-rt-cv:3.1.0) │
│                                                              │
│  metropolis_perception_app -m 7 -r 2 -c perception-config.txt│
│                                                              │
│   source0 (type=3 uri=file://… sync=1 via sinks)             │
│      │                                                       │
│   primary-gie (RT-DETR ONNX → DDETR-TAO parser)              │
│      │                                                       │
│   tracker (IOU; swap to NvDCF for production)                │
│      │                                                       │
│   ┌──┴──────────────────────────────┐                        │
│   │ probe in metropolis_perception_app                       │
│   │   builds NvDsEventMsgMeta per   │                        │
│   │   detection from NvDsObjectMeta │                        │
│   └──┬──────────────────────────────┘                        │
│      │                                                       │
│   sink0 (FakeSink, sync=1)   sink1 (type=6 msg-broker)       │
│                              │                               │
│                              ▼                               │
│                    nvmsgconv (uses dstest5_msgconv_sample…)  │
│                              │                               │
│                              ▼                               │
│                    libnvds_redis_proto.so                    │
│                              │                               │
└──────────────────────────────┼───────────────────────────────┘
                               │ XADD
                               ▼
                     Redis Stream  mdx-raw
                               │
                               ▼
                     your consumer (XREAD)
```

## Event schema (Redis Stream `mdx-raw`)

Each XADD entry has one field, `metadata`, whose value is a **JSON string**:

```json
{
  "version": "4.0",
  "id": "5910",
  "@timestamp": "2026-04-30T14:37:50.075262000Z",
  "sensorId": "0",
  "objects": [
    "143|855.703|285.007|1023.05|359.055|car|#|||||||0.962743",
    "170|1020.73|250.906|1049.27|308.782|person|#|||||||0.880797",
    "1|398.228|202.83|412.397|225.374|road_sign|#|||||||0.883638"
  ]
}
```

Field semantics:

| Field | Meaning |
|---|---|
| `version` | nvmsgconv schema version. `4.0` for our setup. |
| `id` | DeepStream global frame counter. Monotonic across loops; **not** a video-frame index — modulo only matches a single source's frame count and only if the source isn't restarted mid-stream. |
| `@timestamp` | Wall-clock when DeepStream processed the frame. **Not** the source video PTS. With `sync=1` it tracks real time at the source's native FPS. |
| `sensorId` | Comes from `dstest5_msgconv_sample_config.txt` (`[sensor0] id=…`). For multi-stream you must supply one block per stream and map sources to sensors. |
| `objects[i]` | Pipe-delimited string (NOT a JSON object). Format: `track_id\|x1\|y1\|x2\|y2\|class\|#\|...\|confidence`. Index 0 = track ID, 1-4 = bbox in **source video pixel coords** (e.g. 1280×720), 5 = class label, 12 = confidence. |

Key gotchas:
- **Bbox coordinates are in source video pixels**, not the inference resolution (960×544). A canvas overlay on the original video can draw them directly.
- **Object string is positional, not key=value.** Indices 6-11 are reserved for additional fields (object subtype, color, vehicle make/model, etc.) — empty in our pipeline. Always split on `|` and use indices.
- **Track IDs are per-stream**, not globally unique across sensors. Combine with `sensorId` for global uniqueness.
- **Stream is unbounded by default.** Add `XADD ... MAXLEN ~ 100000` or use a cap, otherwise it grows indefinitely.

Reference parsers in this repo:
- Python: see `backend/app/redis_client.py` (XREAD pattern), and the existing `WebSocket /ws/events` consumer in `backend/app/events.py`
- TypeScript: `frontend/src/components/event-feed.tsx` and `frontend/src/components/bbox-overlay.tsx` both parse this format

## The model & parser

| | |
|---|---|
| NGC ID | `nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0` |
| Family | RT-DETR (Real-Time DETR) — Resnet50 backbone + transformer encoder/decoder |
| Classes | 5 (background, bicycle, car, person, road_sign) — `num-detected-classes=5` but background is class 0 and isn't reported |
| Input | NCHW 1×3×544×960 (CHxWxH after `infer-dims=3;544;960`), pixel scale 1/255 |
| Outputs | `pred_logits` (B×300×5), `pred_boxes` (B×300×4 in cxcywh) |
| Parser symbol | `NvDsInferParseCustomDDETRTAO` |
| Parser library | `libnvds_infercustomparser_tao.so` (in image at `/opt/nvidia/deepstream/deepstream-9.0/lib/`) |
| Authoritative config | `data/models/trafficcamnet_transformer/nvdsinfer_config.yaml` (NGC-provided) |

The model name says "RT-DETR" but the working parser is `NvDsInferParseCustomDDETRTAO` (DDETR, not RTDETR). NGC's bundled config picks the DDETR parser intentionally — both architectures emit the same blob layout. There **is** a `NvDsInferParseCustomRTDETRTAO` symbol in `libnvds_infercustomparser.so`, but it produced zero detections in our tests. **Stay with the DDETR parser** unless NVIDIA updates the NGC config.

ONNX file sizes:
- `resnet50_trafficcamnet_rtdetr.fp16.onnx` — 87 MB (used in the POT)
- `resnet50_trafficcamnet_rtdetr.onnx` — 175 MB FP32

To download (the `ngc` CLI's signed-URL handler 403s — use REST):
```bash
curl -sSL --fail \
  -H "Authorization: Bearer $NGC_CLI_API_KEY" \
  -o resnet50_trafficcamnet_rtdetr.fp16.onnx \
  "https://api.ngc.nvidia.com/v2/org/nvidia/team/tao/models/trafficcamnet_transformer_lite/versions/deployable_resnet50_v2.0/files/resnet50_trafficcamnet_rtdetr.fp16.onnx"
```

The TRT engine (`*.fp16.onnx_b1_gpu0_fp16.engine`) is **GPU-arch-specific**. ~3.5 min to build from ONNX on first run; ~5 s warm start once cached. Cache it on a host volume mounted at `/data/models/...`. The cache directory must be writable by UID 1000 (`triton-server` inside the container) — `chmod 777` on the model dir is the simplest fix; `chown 1000:1000` works too.

## Critical (non-obvious) config knobs

These took the most time to discover. Most are documented nowhere obvious — verified against the NGC `nvdsinfer_config.yaml` and the DS sample apps inside the image.

| Setting | Value | Why |
|---|---|---|
| `network-type` | **0** (Detector) | Despite using a custom parser, this stays as the standard Detector type. `100` (Custom) bypasses the metadata population code path that `nvmsgconv` reads. |
| `cluster-mode` | **4** | NMS is done inside the parser; DS shouldn't re-cluster. |
| `parse-bbox-func-name` | `NvDsInferParseCustomDDETRTAO` | See "model & parser" above. |
| `custom-lib-path` | `…/libnvds_infercustomparser_tao.so` | Note the `_tao` suffix; the non-tao file has a different (broken-for-this-model) RTDETR symbol. |
| `output-blob-names` | `pred_logits;pred_boxes` | Order matters; matches the parser's expectations. |
| `maintain-aspect-ratio` | **1** | Letterbox source frames into 960×544. Without it, anamorphic stretch hurts accuracy. |
| `pre-cluster-threshold` | 0.5 | Confidence floor *before* the parser's NMS. Lower = more boxes (more noise). |
| `topk` | 20 | Per-class cap after NMS. |
| Sinks `sync=1` | required for paced playback | Without it, file sources run at ~220 FPS (GPU speed). With it, the sink back-pressures the pipeline to the source's native rate. **Set on every sink** (FakeSink, msg-broker). |
| `msg-conv-config` | `dstest5_msgconv_sample_config.txt` | Without this, `nvmsgconv` has no sensor metadata and silently drops every payload. The file lives in `deepstream/config/` in this repo (copied from `/opt/nvidia/deepstream/deepstream-9.0/sources/apps/sample_apps/deepstream-test5/configs/`). |
| `msg-conv-payload-type` | 1 | `PAYLOAD_DEEPSTREAM_MINIMAL` — what produces the `metadata` JSON-string format above. Type 0 (full) is fine too; type 2 needs a protobuf decoder. |
| `metropolis_perception_app -r N` | publish every N frames | This **overrides** the per-frame interval the config file would otherwise set. `-r 2` at 15 FPS = ~7.5 events/sec. |
| `[tracker] enable=1` | required for `nvmsgconv` to emit | Without persistent track IDs, the event payload generator has no `objectId` to attach. IOU is the simplest tracker; NvDCF is better for re-id. |

## Why `metropolis_perception_app` and not `deepstream-app`

Both are in the `vss-rt-cv:3.1.0` image. They consume the same config format. The difference:

- **`deepstream-app`** (the SDK's standard test app) sets up `nvmsgconv` → `nvmsgbroker`, but `nvmsgconv` only emits a payload when `NvDsEventMsgMeta` is **already attached** to each buffer. Out of the box, nothing attaches it. There's a `nvmsgconv` property `msg2p-newapi=true` that switches it to read `NvDsObjectMeta` directly, but **`deepstream-app` rejects `msg-conv-msg2p-newapi=1` as an unknown config key**. We confirmed this empirically. So with `deepstream-app`, sink type=6 silently sends nothing.
- **`metropolis_perception_app`** ships a buffer probe that walks `NvDsObjectMeta` on every batched frame and builds `NvDsEventMsgMeta` for each detection. Source: `/opt/nvidia/deepstream/deepstream-9.0/sources/apps/sample_apps/metropolis_perception_app/metropolis_perception_app.c` inside the image (look for the `bbox_generated_probe_after_analytics` function and `NvDsEventMsgMeta` references).

CLI flags worth knowing (`--help-all` for the full list):
- `-c <file>` — perception config (entry pipeline)
- `-m N` — PGIE preset selector. `7` = RT-DETR ITS (matches our model). Other values: `0` FSL, `1` MTMC, `2` Resnet 4-class, `3` FSL dual-head, `4` GDINO, `5` Sparse4D, `6` Unknown (default — uses generic detector handling).
- `-r N` — message broker frame interval (every N frames). Overrides config's `msg-conv-frame-interval`.
- `-i <file>` — input override (rare; usually set in config).

## Files to copy / preserve when integrating

These are the working artifacts. Everything else in the repo is demo glue.

| Path | Purpose |
|---|---|
| `deepstream/config/perception-config.txt` | Top-level pipeline config (source, streammux, primary-gie ref, tracker ref, OSD, sinks). |
| `deepstream/config/rtdetr-960x544.txt` | Primary-GIE config — model paths, parser, thresholds. |
| `deepstream/config/rtdetr-960x544-labels.txt` | Class labels (5 lines, one per class). |
| `deepstream/config/config_tracker_IOU.yml` | Tracker config. Replace with `config_tracker_NvDCF_perf.yml` for production. |
| `deepstream/config/dstest5_msgconv_sample_config.txt` | Sensor mapping — required by nvmsgconv. Edit `[sensor0]` to set your real sensor IDs. |
| `deepstream/init/ds-start.sh` | Container entrypoint. Stages configs into `/tmp/ds-config/`, substitutes `STREAM_URI_PLACEHOLDER` and `REDIS_HOST_PLACEHOLDER`, exec's `metropolis_perception_app`. |
| `data/models/trafficcamnet_transformer/resnet50_trafficcamnet_rtdetr.fp16.onnx` | The ONNX model. Treat as a build artifact — re-download from NGC during setup, do not commit. |
| `data/models/trafficcamnet_transformer/labels.txt` | NGC-shipped labels (5 entries). |
| `data/models/trafficcamnet_transformer/nvdsinfer_config.yaml` | NGC-shipped reference config — useful for verifying our `rtdetr-960x544.txt`. |

These are reference for parsing the output schema:
- `frontend/src/components/bbox-overlay.tsx` — minimal canvas-overlay implementation (Browser/TS)
- `frontend/src/components/event-feed.tsx` — text-based event feed (Browser/TS)
- `backend/app/redis_client.py` + `backend/app/events.py` — XREAD + WebSocket bridge (Python)

## Image / runtime requirements

| | |
|---|---|
| Container image | `nvcr.io/nvidia/vss-core/vss-rt-cv:3.1.0` |
| Pull credentials | NGC API key (`docker login nvcr.io -u '$oauthtoken' -p $NGC_CLI_API_KEY`) |
| Container runtime user | UID 1000 (`triton-server`) |
| GPU | Any CUDA-13.1-capable NVIDIA GPU (Ampere+, including A6000) |
| Host driver | 580+ (DS 9.0 ships CUDA 13.1 runtime). Tested on 595.58.03. |
| Docker runtime | nvidia (default-runtime in `/etc/docker/daemon.json`) |
| Volumes | `data/models:/data/models` (rw, must be writable by UID 1000), `data/videos:/data/videos` (input files), `deepstream/config:/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app` (configs), `deepstream/init/ds-start.sh:/ds-start.sh:ro` |
| Networking | needs to reach a Redis instance (default `redis:6379`); ports 6379 and the SDR port `4001` if SDR is in use |
| Memory | ~2 GB GPU, ~1 GB system at idle |

## Known broken things (don't waste cycles)

| Symptom | Root cause | Workaround |
|---|---|---|
| `ngc registry model download-version` fails with `Download status: FAILED` and 4-files-failed instantly | The `ngc` CLI's signed-URL handler doesn't follow the redirect to `xfiles.ngc.nvidia.com` correctly. | Use REST API directly: `curl -L -H "Authorization: Bearer $NGC_CLI_API_KEY" https://api.ngc.nvidia.com/v2/org/nvidia/team/tao/models/.../files/<file>` |
| NVStreamer 3.1.0 `RTSP DESCRIBE` returns 404; logs show `Container: , videoCodec:` empty and "Codec format not supported" | ⚠️ **Re-diagnosed 2026-05-12 — root cause was wrong.** Original symptom is real, but the cause is not "metadata discovery is broken." The container ships `launch_vst` compiled against libav60 with ~30 FFmpeg runtime libs stripped from the rootfs; only the file-streamer adapter triggers that broken path, and the team had also called a non-existent API (`POST /api/v1/file`). The RTSP-source path works fine. See [`../../state/log/2026-05-12-nvstreamer-rediagnosis.md`](../../state/log/2026-05-12-nvstreamer-rediagnosis.md). | Wrap uploads as RTSP sources via mediamtx, register via `POST /api/v1/sensor/add`. Tracked under [Phase F of multi-user-uploads.md](../phases/multi-user-uploads.md). The `uridecodebin` direct-file workaround is being retired. |
| `docker login nvcr.io` fails with DNS error mentioning `shadeform`; image pulls fail similarly | Brev base image ships with `/etc/systemd/system/docker.service.d/http-proxy.conf` setting `HTTP_PROXY=shadeform/`. | `sudo rm /etc/systemd/system/docker.service.d/http-proxy.conf && sudo systemctl daemon-reload && sudo systemctl restart docker`. |
| Pipeline runs at 220 FPS, file sink output grows unbounded with `[tests] file-loop=1` | `sync=0` (default) on sinks doesn't back-pressure. | Set `sync=1` on at least one sink. Avoid using a file output sink with `file-loop=1`. |
| Redis stream `mdx-raw` channel exists in `PUBSUB CHANNELS` but `redis-cli MONITOR` shows zero `XADD` even though detections happen | Using `deepstream-app` as entrypoint. `nvmsgconv` needs pre-attached `NvDsEventMsgMeta`. | Switch entrypoint to `metropolis_perception_app -m 7 -r 2`. |
| `deepstream-app` warns `Unknown key 'msg-conv-msg2p-newapi' for group [sink1]` | The CLI flag isn't recognized as a deepstream-app config key in DS 9.0. | Don't try to fix this — switch to `metropolis_perception_app` (above). |
| OSD draws no bboxes despite pipeline running at full FPS | Wrong parser; we initially tried a non-existent `libnvdsinfer_custom_impl_Transformer.so`. | Use `NvDsInferParseCustomDDETRTAO` from `libnvds_infercustomparser_tao.so`. |

## Quick smoke test (single-shot, no compose)

After copying the `deepstream/` directory and a model into `data/models/trafficcamnet_transformer/`:

```bash
# Pull image (requires NGC login)
echo "$NGC_CLI_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin
docker pull nvcr.io/nvidia/vss-core/vss-rt-cv:3.1.0

# Start a redis to receive events
docker run -d --rm --name smoke-redis -p 6379:6379 redis:8.2.2-alpine

# Drop a video at data/videos/test.mp4 and a stream URL hint
mkdir -p data/videos data/models
echo "file:///data/videos/test.mp4" > data/videos/current_stream_url.txt
chmod -R 777 data/models  # so triton-server (uid 1000) can write the engine

# Run perception, attached to host's redis
docker run --rm --gpus all \
  -v $(pwd)/data:/data \
  -v $(pwd)/deepstream/config:/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app \
  -v $(pwd)/deepstream/init/ds-start.sh:/ds-start.sh:ro \
  -e REDIS_HOST=host.docker.internal \
  --add-host=host.docker.internal:host-gateway \
  --entrypoint /ds-start.sh \
  nvcr.io/nvidia/vss-core/vss-rt-cv:3.1.0
```

In another terminal:
```bash
docker exec smoke-redis redis-cli XLEN mdx-raw      # should grow
docker exec smoke-redis redis-cli XREVRANGE mdx-raw + - COUNT 1   # see latest event
```

Look for `**PERF: 15.00` in the perception app's stdout (or whatever your video's FPS is) and `n events / 10s` matching `(fps / -r) * 10`.

## Reference consumer (Python, asyncio)

```python
import asyncio
import json
import redis.asyncio as redis

async def consume(redis_url: str = "redis://localhost:6379"):
    client = redis.from_url(redis_url, decode_responses=True)
    last_id = "$"  # only new events; use "0-0" to replay
    async with client:
        while True:
            messages = await client.xread({"mdx-raw": last_id}, block=0)
            for _stream, entries in messages:
                for msg_id, data in entries:
                    last_id = msg_id
                    meta = json.loads(data["metadata"])
                    sensor_id = meta["sensorId"]
                    frame_id = meta["id"]
                    for obj_str in meta.get("objects", []):
                        p = obj_str.split("|")
                        track_id = p[0]
                        x1, y1, x2, y2 = map(float, p[1:5])
                        cls = p[5]
                        confidence = float(p[12]) if len(p) > 12 and p[12] else 0.0
                        yield {
                            "sensor_id": sensor_id,
                            "frame_id": int(frame_id),
                            "track_id": track_id,
                            "class": cls,
                            "bbox": [x1, y1, x2, y2],
                            "confidence": confidence,
                        }

async def main():
    async for det in consume():
        print(det)

asyncio.run(main())
```

## Deeper-dive references

- DS API ref: https://docs.nvidia.com/metropolis/deepstream/sdk-api-ref/
- DS plugin manual: https://docs.nvidia.com/metropolis/deepstream/dev-guide/text/DS_plugin_gst-nvmsgconv.html (gst-nvmsgconv element properties)
- VSS docs: https://docs.nvidia.com/vss/
- TAO TrafficCamNet Transformer model card: https://catalog.ngc.nvidia.com/orgs/nvidia/teams/tao/models/trafficcamnet_transformer_lite
- Inside the image, study: `/opt/nvidia/deepstream/deepstream-9.0/sources/apps/sample_apps/metropolis_perception_app/metropolis_perception_app.c` (probe that creates `NvDsEventMsgMeta`); `/opt/nvidia/deepstream/deepstream-9.0/sources/apps/sample_apps/deepstream-test5/configs/dstest5_msgconv_sample_config.txt` (sensor mapping schema reference).

---

# Part 2 — What to keep / drop when adapting this repo

## Keep
- `vss-rt-cv` (`metropolis_perception_app` + RT-DETR ITS + IOU tracker + Redis msg broker) — this is the value of the POT.
- `redis` — message bus between perception and consumers. Stream `mdx-raw` (schema documented above).
- `data/models/trafficcamnet_transformer/` cache (or rebuild from NGC at setup).
- The `deepstream/` directory verbatim.

## Drop
- `nvstreamer/` and the `vss-nvstreamer` service — confirmed not needed; 3.1.0 discovery is broken anyway.
- `sdr/` and the `vss-sdr` service if multi-source dynamic stream management isn't part of the larger app. (Re-evaluate when adding multi-stream — see Phase 2.)
- `frontend/` — demo UI; the larger app has its own. The bbox-overlay component is useful as a reference but not as a deployed service.
- `backend/` — most of it is demo glue (upload flow, video playback, frontend proxy). Worth keeping as reference: `redis_client.py`, `events.py`.
- `smoke-test.ipynb`, `Untitled.ipynb`, ad-hoc files in `data/videos/`.

# Part 3 — Phased plan to evolve this repo into the larger app's RT-CV component

## Phase 1 — Strip to a deployable service (~1 day)
1. Remove `nvstreamer` and `frontend` from `docker-compose.yml`. Drop the `_get_nvstreamer_rtsp_url` polling code and the upload→nvstreamer→register flow in `backend/app/upload.py`.
2. Replace the file-upload entrypoint with whatever the larger app produces:
   - **Option A** — larger app drops files into a shared directory; perception watches it and processes as they arrive. Requires a small "ingest watcher" that writes paths to `current_stream_url.txt` and restarts vss-rt-cv (or, better, sends an SDR-style update without restart).
   - **Option B** — larger app produces RTSP streams (their own streaming server, not NVStreamer 3.1.0). Source becomes `type=4 uri=rtsp://...`. SDR is back in scope.
3. Define the public API contract from perception:
   - **Stream**: Redis stream `mdx-raw` with the schema documented in Part 1.
   - **Health**: `vss-rt-cv` container restart count + Redis stream length + last event timestamp.
4. Move secrets out of `.env` (NGC key is in plaintext today). Consumers in the larger app should not need NGC at runtime — only the build/setup step does.

## Phase 2 — Multi-stream (~2-3 days)
1. Switch source0 to a **multi-uri source list** or use SDR to dynamically add/remove sources without restarts. SDR talks to vss-rt-cv over Redis (`mdx-rtsp-srv`); the existing `register_stream` / `remove_active_stream` calls in `backend/app/sdr.py` already speak that protocol.
2. Map source ID → sensor ID in `dstest5_msgconv_sample_config.txt`. One `[sensorN]` block per source so events carry a meaningful `sensorId`.
3. Tracker swap: `config_tracker_IOU.yml` → `config_tracker_NvDCF_perf.yml`. NvDCF gives better re-identification across occlusions and exposes velocity/direction in per-track state — needed for accident heuristics.
4. The streammux block needs `batch-size` >= number of streams, and `batched-push-timeout` tuned (~40 ms is fine).

## Phase 3 — Accident-detection analytics (~3-5 days)

Two layers, both consume `mdx-raw`:

### 3a. `nvdsanalytics` (in-pipeline, free metadata)
Add an `[nvds-analytics]` block to `perception-config.txt` referencing a config that defines:
- **ROIs** for road / lanes / shoulder / intersection
- **Line crossings** for direction-of-travel detection
- **Loitering** thresholds

Output appears as `NvDsAnalyticsObjMeta` on each object. Plumb it into `dstest5_msgconv_sample_config.txt`'s payload so it ships with each event (extra fields per object: ROI label, direction, loitering flag).

### 3b. Heuristic accident detector (downstream service)
A new service (Python or Go, decoupled from this repo) that subscribes to `mdx-raw` and flags:
- **Collision signature**: two vehicle tracks with bbox IoU > 0.4 *and* both decelerating > N px/frame²
- **Sudden stop on roadway**: track velocity drops to ~0 inside the road ROI for > 2 s
- **Stationary obstruction**: track stationary > 10 s in a non-shoulder ROI
- **Wrong-way driving**: direction crossing the wrong way over an analytics line

Inputs from the event stream + a per-track ring buffer of last N positions for velocity. Output: `accident_event` records on a separate Redis stream `accidents-raw`, with `{video_id, timestamp, location_bbox, classifier_signal, contributing_track_ids[]}`.

Keep these heuristics out of DeepStream — they're pure data analysis, easier to tune and unit-test in plain code than via DS probes.

### 3c. Optional ML classifier
If heuristics false-positive too much on the larger app's footage:
- Trigger a video-clip classifier (TAO video classification pipeline or a 3D-CNN) only on tracks the heuristic flags
- Keeps GPU cost low — only run the heavy model on suspect clips
- Requires labeled accident/non-accident clips. NVIDIA TAO has anomaly workflows but no off-the-shelf accident model.

## Phase 4 — Hardening
- **Auth**: today the WebSocket and Redis are open inside the docker network. For embedding in a larger app, either keep perception fully internal (preferred) or front it with the larger app's existing auth.
- **Persistence**: `mdx-raw` is in-memory and capped (`XLEN` grows unbounded today — should `XADD ... MAXLEN ~ 100000`). If long-term storage matters, sink events to a time-series DB (TimescaleDB / ClickHouse) via a separate consumer.
- **Observability**: container restart counts, TRT engine build time, FPS, msg-broker rate, Redis stream depth — emit as Prometheus metrics from a small exporter.
- **Engine portability**: the TRT engine is GPU-arch-specific. CI should rebuild on the target GPU or download the ONNX and let DS build on first launch.
- **Pin versions**: `PERCEPTION_TAG`, `SDR_TAG` should be pinned to specific 3.x.y versions. NVStreamer 3.1.0's discovery bug is a cautionary example.

## Open questions for the larger app
- **Input contract** — files, RTSP, WebRTC, IPC? Decides Phase 1 Option A vs B.
- **Single tenant or multi-tenant**? Drives auth + sensor namespacing.
- **Where does accident-detection output go** — Slack, dashboard, downstream automation? Drives the schema of `accidents-raw`.
- **Latency budget** — real-time alerts (sub-second) vs batched analytics (per-minute summary)? Current ~7-8 events/sec at video rate is fine for either; the heuristics' detection latency is what matters.
- **GPU sharing**: will perception share a GPU with other workloads? Affects MIG / MPS planning.

## Concrete next-session checklist
1. `docker compose down vss-nvstreamer vss-frontend` and remove their entries from `docker-compose.yml`. Remove `nvstreamer/` and `frontend/` directories.
2. Trim `backend/app/upload.py` to just the file-write + `_update_vss_rt_cv_stream` path; drop NVStreamer polling and Brev-frontend-specific bits.
3. Add `XADD ... MAXLEN ~ 100000` to bound the Redis stream (set the cap inside `dstest5_msgconv_sample_config.txt` or via a downstream cap consumer; nvmsgbroker doesn't accept MAXLEN directly).
4. Document the `mdx-raw` event schema in a top-level `SCHEMA.md` (or extract from this file).
5. Decide Phase 1 Option A vs B with the larger-app team and stub out the new ingest path.
