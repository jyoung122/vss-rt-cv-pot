# VSS-RT-CV POT — Current State

## What's Working
- All 7 containers defined and wired in docker-compose
- NVStreamer: `streamer` adaptor enabled, auto-discovers video files, serving 8 RTSP streams
- GPU accessible in both NVStreamer and vss-rt-cv containers
- Backend: upload API saves file, restarts NVStreamer, polls for RTSP URL, writes `current_stream_url.txt`, restarts vss-rt-cv
- DeepStream: ds-start.sh reads stream URI from shared file, patches config to writable `/tmp`
- Redis, Redis Commander, Frontend all healthy

## NVStreamer Config (3.1.0 — differs from 3.0.0 docs)
- HTTP API port: **30000** (not 31000)
- RTSP: each file gets its own port (30554+), not shared
- RTSP URL format: `rtsp://<host>:<port>/nvstream/home/vst/vst_release/streamer_videos/<filename>`
- Adaptor: must enable `streamer` in `adaptor_config.json` (default is `onvif` for cameras)
- Video mount path: `/home/vst/vst_release/streamer_videos` (not `/data/videos`)
- Files only scanned at startup — new uploads require container restart
- Streams API: `GET /api/v1/sensor/streams`
- File upload API (`POST /api/v1/storage/file`) broken in 3.1.0 (missing libav, gst_discoverer fails)

## Blocker
NGC API key returns **403** on model file downloads. TrafficCamNet Transformer Lite model needs to be placed at:
```
data/models/trafficcamnet_transformer/trafficcamnet_transformer_lite_vdeployable_resnet50_v2.0/
```

Fix options:
1. Regenerate NGC API key with download permissions
2. Accept model license at ngc.nvidia.com first
3. Download manually via browser, then `brev copy` to instance

Once model is in place: `docker restart vss-rt-cv`

## Key Files Changed
- `docker-compose.yml` — ports, volumes, GPU, env vars for all services
- `nvstreamer/configs/adaptor_config.json` — streamer adaptor enabled
- `backend/app/upload.py` — full upload→restart→poll→register flow
- `deepstream/init/ds-start.sh` — reads URL from file, writes config to /tmp
- `deepstream/config/perception-config.txt` — STREAM_URI_PLACEHOLDER

## SDR
Restart-looping — likely resolves once vss-rt-cv is healthy. Non-critical for POT.

## Next Steps
1. Fix NGC model download (see Blocker above)
2. Verify DeepStream connects to NVStreamer RTSP stream
3. Verify perception events flow to Redis
4. Test end-to-end: upload → detect → browser event feed
