# VSS-RT-CV POT — Current State

## What's Working
- All 7 containers defined and wired in docker-compose
- NVStreamer: `streamer` adaptor enabled, auto-discovers video files, serving 8 RTSP streams
- GPU accessible in NVStreamer container
- Backend: upload API saves file, restarts NVStreamer, polls for RTSP URL, writes `current_stream_url.txt`, restarts vss-rt-cv
- DeepStream: ds-start.sh reads stream URI from shared file, stages all configs (perception + rtdetr + labels) into `/tmp/ds-config` and `cd`s there so relative `config-file=` resolves
- TrafficCamNet ONNX model is in place at `data/models/trafficcamnet_transformer/resnet50_trafficcamnet_rtdetr.fp16.onnx` (NGC blocker resolved)
- SDR no longer restart-looping (see SDR section)
- Redis, Redis Commander, Frontend, Backend all healthy

## NVStreamer Config (3.1.0 — differs from 3.0.0 docs)
- HTTP API port: **30000** (not 31000)
- RTSP: each file gets its own port (30554+), not shared
- RTSP URL format: `rtsp://<host>:<port>/nvstream/home/vst/vst_release/streamer_videos/<filename>`
- Adaptor: must enable `streamer` in `adaptor_config.json` (default is `onvif` for cameras)
- Video mount path: `/home/vst/vst_release/streamer_videos` (not `/data/videos`)
- Files only scanned at startup — new uploads require container restart
- Streams API: `GET /api/v1/sensor/streams`
- File upload API (`POST /api/v1/storage/file`) broken in 3.1.0 (missing libav, gst_discoverer fails)

## SDR — Fixed (was restart-looping)
SDR assumes a K8s-pod-style deployment. Two issues, both addressed:
1. SDR talks to the Docker socket — mount `/var/run/docker.sock` into the service.
2. The binary hardcodes `localhost:6379` for Redis — use `network_mode: "service:redis"` so SDR shares the redis container's network namespace. Port 4001 is now exposed via the `redis` service since SDR no longer has its own netns.

After the fix, SDR runs and waits for VST (`Some error (this is expected)` retries are non-fatal per the app itself).

## Current Blocker — NVIDIA driver too old for vss-rt-cv:3.1.0
DeepStream inside `vss-rt-cv:3.1.0` ships **CUDA 13.1** runtime. Host driver is **570.195.03** (max CUDA 12.8). Container fails with:
```
Error: Could not get cuda device count (cudaErrorInsufficientDriver)
Cuda failure: status=35
```
The container restart-loops on this. ONNX model + config staging are fine — the driver is the only thing standing between us and a working pipeline.

**Options:**
1. **Re-provision the Brev instance** with an image carrying driver 580+ (cleanest path on Brev — driver is typically baked into the image).
2. **In-place upgrade** — add NVIDIA's CUDA repo / graphics-drivers PPA, `apt install nvidia-driver-580`, then reboot from the Brev console. Apt currently only offers 570.211.01 (same series, won't help).
3. **Pin to an older vss-rt-cv image** (e.g. a 2.x / CUDA-12-based tag) if compatible with the rest of the 3.1.0 stack.

## Key Files Changed (this session)
- `deepstream/init/ds-start.sh` — stage perception-config.txt + rtdetr-960x544.txt + rtdetr-960x544-labels.txt into `/tmp/ds-config`, `cd` there before exec'ing deepstream-app. Also restored exec bit (was 644, now 755).
- `docker-compose.yml` — added docker.sock mount + `network_mode: "service:redis"` for SDR; moved port 4001 mapping to the redis service.

## Earlier Files Changed
- `docker-compose.yml` — ports, volumes, GPU, env vars for all services
- `nvstreamer/configs/adaptor_config.json` — streamer adaptor enabled
- `backend/app/upload.py` — full upload→restart→poll→register flow
- `deepstream/config/perception-config.txt` — STREAM_URI_PLACEHOLDER

## Known Repo Hygiene Issues
- `smoke-test.ipynb` has a hardcoded NGC API key in a notebook cell. Should be read from `os.environ["NGC_CLI_API_KEY"]` / `.env` before being committed.

## Next Steps
1. Get a 580+ NVIDIA driver onto the host (re-provision Brev instance preferred)
2. Verify DeepStream connects to NVStreamer RTSP stream
3. Verify perception events flow to Redis
4. Test end-to-end: upload → detect → browser event feed
