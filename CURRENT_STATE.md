# VSS-RT-CV POT — Current State

## What's Working
- All 7 containers up and stable
- DeepStream perception pipeline runs end-to-end at the source video's native rate (~15 FPS) thanks to `sync=1` on the sinks
- TrafficCamNet RT-DETR model loaded; TRT FP16 engine builds in ~3.5 min and persists between restarts (~5 s warm start after the first build)
- IOU tracker assigns persistent IDs across frames
- `metropolis_perception_app` (NVIDIA's reference VSS app) emits `NvDsEventMsgMeta` → `nvmsgconv` → Redis Stream `mdx-raw` at ~7-8 events/sec (`-r 2` → publish every 2 frames)
- Backend `XREAD`s the stream and forwards each event to all WebSocket clients on `/ws/events`
- Frontend renders detections in two places: an event feed (text list) and bounding-box canvas overlay over the playing video
- All four object classes detected: car / bicycle / person / road_sign — high confidence on cars (0.9+)

## End-to-end pipeline
```
metropolis_perception_app (in vss-rt-cv)
  ├── source0 (type=3, uri=file:///data/videos/<file>, sync=1)
  ├── primary-gie  (RT-DETR ONNX → DDETR-TAO parser → NvDsObjectMeta)
  ├── tracker      (IOU, persistent IDs)
  ├── osd          (draws bboxes — used for visual verification)
  ├── sink0        (FakeSink, sync=1 → paces pipeline to video FPS)
  └── sink1 (type=6 msg-broker)
        nvmsgconv  (config = dstest5_msgconv_sample_config.txt)
        nvmsgbroker (libnvds_redis_proto.so → XADD mdx-raw)
                                ↓
                       Redis Stream mdx-raw
                                ↓
                  backend XREAD (redis_client.py)
                                ↓
                  WebSocket /ws/events  (events.py)
                                ↓
                  Frontend (event-feed + bbox-overlay)
```

Sample event payload:
```json
{
  "metadata": "{\"version\":\"4.0\",\"id\":\"5910\",\"@timestamp\":\"...\",\"sensorId\":\"0\",\"objects\":[\"177|925.0|264.6|993.6|299.9|bicycle|#|||||||0.66\",\"143|855.7|285.0|1023.0|359.0|car|#|||||||0.96\"]}"
}
```
Each object string: `track_id | x1 | y1 | x2 | y2 | class | # | ... | confidence` (coords in source video pixels — 1280×720 for the demo file).

## Frontend
- **Same-origin proxy via Next.js** so the whole app works behind one Brev/Cloudflare hostname (no CORS, single auth):
  - `next.config.js` rewrites `/api/:path*` and `/ws/:path*` → `http://backend:8080`
  - `src/app/api/upload/route.ts` is a streaming Route Handler that forwards multipart to backend (rewrites alone mangle multipart body parsing — Starlette returns "There was an error parsing the body")
  - `src/app/page.tsx` derives `wsUrl` from `window.location` so `wss://` works automatically over HTTPS
- **Bbox overlay** (`src/components/bbox-overlay.tsx`): absolute-positioned `<canvas>` over the `<video>`. Subscribes to `/ws/events`, draws colored boxes (car=blue, person=green, bicycle=amber, road_sign=pink) at the latest frame's coordinates. Canvas's intrinsic resolution is fixed at 1280×720 and CSS-scaled to the displayed video size, so coords land correctly regardless of viewport.
- **Event feed** (`src/components/event-feed.tsx`): scrollable text list capped at 70vh / min 300px; auto-scrolls to top **only when already near the top** (so manual inspection of older events isn't yanked back).
- **Stream cleared on each upload** (`backend/app/upload.py` calls `clear_stream` before restarting vss-rt-cv) so the feed/overlay start fresh.

## Discovery bug — NVStreamer 3.1.0 (upstream, unresolved)
NVStreamer 3.1.0 does not populate codec/container metadata for files it serves. `updateFileMetadata` consistently logs `Container: , videoCodec:` (both empty), `create_video_pipeline` rejects with "Codec format not supported", and the documented `POST /api/v1/file` upload API returns 404 in this build. Tested mp4 ✓, h264 ✓, with/without audio, baseline profile, +faststart — all hit the same failure.

**Workaround in place:** `/api/upload` writes `file:///data/videos/<filename>` directly to `current_stream_url.txt` and DeepStream reads via `uridecodebin`. NVStreamer is not in the perception path. The container is still up but unused for streaming.

## Fixes landed this session
**DeepStream**
- `deepstream/config/rtdetr-960x544.txt` — canonical NVIDIA config from NGC `nvdsinfer_config.yaml`: parser `NvDsInferParseCustomDDETRTAO` from `libnvds_infercustomparser_tao.so`, `network-type=0`, `cluster-mode=4`, `output-tensor-meta=1`, `maintain-aspect-ratio=1`, `topk=20`, `pre-cluster-threshold=0.5`. Original config referenced a library that doesn't exist in this image.
- `deepstream/config/perception-config.txt` — source `type=3` (file URI), tracker enabled, sink0 type=1 with `sync=1` (FakeSink that paces pipeline to video FPS), sink1 type=6 with `msg-conv-config=dstest5_msgconv_sample_config.txt`, `msg-conv-payload-type=1`, `msg-conv-frame-interval=2`. **Removed** the file-output sink — the unbounded mkv was filling disk.
- `deepstream/init/ds-start.sh` — entrypoint switched from `deepstream-app` to `metropolis_perception_app -m 7 -r 2`. `deepstream-app` won't generate `NvDsEventMsgMeta`; `metropolis_perception_app` does. Also stages `config_tracker_IOU.yml` and `dstest5_msgconv_sample_config.txt`.
- `deepstream/config/config_tracker_IOU.yml`, `deepstream/config/dstest5_msgconv_sample_config.txt` — copied from the in-image samples dir.

**Backend**
- `backend/Dockerfile` — installs `curl` (upload flow shells out to `curl --unix-socket` for Docker API).
- `backend/app/upload.py` — returns `playback_url: /api/video/{video_id}`; bypasses NVStreamer (writes `file://` URL directly to `current_stream_url.txt`); calls `clear_stream(REDIS_URL)` to drop prior events.

**Frontend**
- `frontend/next.config.js` — rewrites for `/api/*` and `/ws/*` to backend.
- `frontend/src/app/api/upload/route.ts` — streaming multipart proxy (fixes "There was an error parsing the body" via plain rewrite).
- `frontend/src/app/page.tsx` — derives wsUrl from window.location; passes wsUrl/resetKey to VideoPlayer.
- `frontend/src/components/upload-button.tsx` — relative URLs (`apiUrl=''`).
- `frontend/src/components/event-feed.tsx` — parses `metadata` JSON-string and pipe-delimited objects; scrollable; smarter auto-scroll.
- `frontend/src/components/bbox-overlay.tsx` — new canvas overlay.
- `frontend/src/components/video-player.tsx` — wraps video + overlay.
- `docker-compose.yml` — removed `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` build args (frontend is now origin-agnostic).

**Host / infra**
- Removed `/etc/systemd/system/docker.service.d/http-proxy.conf` (Brev artifact pointing docker daemon at a non-existent `shadeform/` proxy).
- `chmod 777 data/models/trafficcamnet_transformer/` so the container's `triton-server` UID can persist the TRT engine file.
- Disk cleanup: `journalctl --vacuum-size=200M` (-3.1 GB), `docker image prune -a` (-119 MB), removed `/tmp/perception-out*.{mp4,mkv}` artifacts. Note: 71 GB on `/var/lib/containerd` is Brev's own runtime, not ours.

## NGC notes
- The `ngc` CLI's signed-URL download handler 403s on the redirect to `xfiles.ngc.nvidia.com`. Worked around by hitting the REST API directly with a bearer token: `curl -L -H "Authorization: Bearer $NGC_CLI_API_KEY" https://api.ngc.nvidia.com/v2/.../files/<name>`.
- API key in `.env` as `NGC_CLI_API_KEY`; org `nvidia`; model `nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0`.

## Public access (Brev)
Use `https://ui-blxuttpxb.brevlab.com` (or `https://3000-blxuttpxb.brevlab.com` — same backend). Cloudflare Access auth happens once, then upload + playback + WebSocket all flow through the same hostname via the Next.js proxy.

## Known repo hygiene
- `smoke-test.ipynb` reads `NGC_CLI_API_KEY` from env (older note about a hardcoded key is stale).
- `nvstreamer` service is still in compose but not used; could be removed once NVStreamer 3.1.0 discovery is fixed upstream or the team accepts file:// permanently.

## Next Steps
1. Decide on NVStreamer: pin a 3.0.0 image (where the documented dashboard upload works), wait for 3.2.0, or accept the `file://` bypass as the long-term path.
2. If multi-stream / multi-camera demos are planned, the current single-source/single-sensor wiring needs a multi-uri source list and per-source sensor-id mapping in `dstest5_msgconv_sample_config.txt`.
3. Tunable demo knobs: `pre-cluster-threshold` (0.5 default), `-r N` message-rate, IOU tracker swap to NvDCF for better re-id.
