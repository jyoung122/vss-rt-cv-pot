# NVStreamer

NVIDIA NVStreamer 3.1.0 — a video ingest and RTSP re-streaming sidecar from the VSS Core image set. In the original AIMS design, uploads would be registered with NVStreamer, which would re-serve them over RTSP for DeepStream to consume. **In v1 today, NVStreamer is in the compose stack but bypassed**: the backend writes `file:///data/videos/<filename>` directly to `current_stream_url.txt` and DeepStream reads it via `uridecodebin`. This is being replaced — see "Path forward" below.

## Container / process

- **Image:** `nvcr.io/nvidia/vss-core/vss-vios-nvstreamer:${NVSTREAMER_TAG}` (tag default `3.1.0`)
- **Compose service name:** `nvstreamer`
- **Container name:** `vss-nvstreamer`
- **Network:** `vss-net`
- **Dependencies:** none
- **Ports:** `30000:30000` (management API), `30554–30580:30554–30580` (RTSP range)
- **Volumes:**
  - `${DATA_DIR}/videos:/home/vst/vst_release/streamer_videos` — video files
  - `./nvstreamer/configs/adaptor_config.json:/home/vst/vst_release/configs/adaptor_config.json` — NVStreamer adapter config
- **GPU:** device `0`, all NVIDIA capabilities
- **Healthcheck:** none defined

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `NVSTREAMER_TAG` | `3.1.0` | Image tag |
| `NVIDIA_DRIVER_CAPABILITIES` | `all` | Container GPU capabilities |
| `NVIDIA_VISIBLE_DEVICES` | `all` | GPU visibility |

`NVSTREAMER_URL` (`http://nvstreamer:30000`) is passed to `sdr` and `backend` but the backend's upload path does not actually call NVStreamer in v1.

## Known issues / gotchas

Re-diagnosed 2026-05-12 — see [`docs/state/log/2026-05-12-nvstreamer-rediagnosis.md`](../../../state/log/2026-05-12-nvstreamer-rediagnosis.md) for the full investigation. The original "upstream metadata discovery bug" claim was wrong in framing:

- **The real API is `/api/v1/sensor/*` + `/api/v1/storage/*`.** `POST /api/v1/file` (the path the team tried) has never existed. Source registration is `POST /api/v1/sensor/add` with `{name, sensorUrl, location, tags, username, password}`; file auto-discovery happens via the `streamer` adapter (enabled in our [`nvstreamer/configs/adaptor_config.json`](../../../../nvstreamer/configs/adaptor_config.json)).
- **File-streamer code path is broken in this 3.1.0 image.** `launch_vst` was compiled against `libav60` but the container has ~30 FFmpeg runtime libs stripped from its rootfs (libgme, libopenmpt, libchromaprint, libbluray, libvpx, libx264, libx265, libxvidcore, libmpg123, libFLAC, libbs2b, libcdio, libmp3lame, libzvbi, librist, libsrt-gnutls, libssh-gcrypt, libzmq, librabbitmq, …) while their dpkg metadata was left behind. `apt install` no-ops, `apt install --reinstall` brings them back one batch at a time. Each round uncovers more transitive deps — not a viable fix.
- **The RTSP code path works fine.** When a source is registered via `POST /api/v1/sensor/add` with an RTSP URL (rather than discovered as a local file), NVStreamer probes via GStreamer (`gst_utils.cpp:getRTSPStreamDetails`) — no libav involvement — extracts codec/resolution/fps correctly, and serves a proxy RTSP URL at `rtsp://<bridge-ip>:30554/live/<uuid>`. This is the code path VSS production deploys actually exercise (cameras, not files), which is why this bug hasn't surfaced upstream.
- **Adapter config matters.** Default `adaptor_config.json` ships all adapters `enabled:false`. Our compose mounts `./nvstreamer/configs/adaptor_config.json` over it, which enables the `streamer` adapter. The team's 2026-04-30 test inadvertently used the in-container default (override mount missing or wrong) and saw `[]` for `sensor/list` — interpreted as "discovery broken" but actually "no adapter enabled to discover anything."

## Path forward

Going forward we will **register uploaded files as RTSP sources, not as local files** — the path NVStreamer is actually tested by NVIDIA, no patching required:

```
upload  ─→ /data/videos/<id>.mp4
        ─→ ffmpeg -re -stream_loop -1 -i <file> -c copy -f rtsp rtsp://mediamtx:8554/<id>
        ─→ POST /api/v1/sensor/add  {sensorUrl: "rtsp://mediamtx:8554/<id>", ...}
        ─→ NVStreamer assigns proxy URL  rtsp://<nvstreamer>:30554/live/<uuid>
        ─→ SDR registers that proxy URL with DeepStream nvstreammux (dynamic add, no restart)
```

Tracked under Phase F of [`../../phases/multi-user-uploads.md`](../../phases/multi-user-uploads.md). The current `current_stream_url.txt` + container-restart workaround goes away as part of that work.

## Related plan items

- [Multi-user uploads + parallel GPU processing](../../phases/multi-user-uploads.md) — Phase F drives the NVStreamer re-integration
- [2026-05-12 re-diagnosis log](../../../state/log/2026-05-12-nvstreamer-rediagnosis.md)
- [Locked decision D4 — Upload-only; RTSP deferred](../../../V1_PLAN.md#locked-decisions)
