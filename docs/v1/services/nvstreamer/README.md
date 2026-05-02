# NVStreamer

NVIDIA NVStreamer 3.1.0 — a video ingest and RTSP re-streaming sidecar from the VSS Core image set. In the original AIMS design, uploads would be registered with NVStreamer, which would re-serve them over RTSP for DeepStream to consume. **In the current upload-only v1, NVStreamer is in the compose stack but is not in the active perception path.** The backend writes `file:///data/videos/<filename>` directly to `current_stream_url.txt` and DeepStream reads it via `uridecodebin`, bypassing NVStreamer entirely.

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

- **NVStreamer 3.1.0 discovery bug (upstream, unresolved).** `POST /api/v1/file` returns 404; codec/container metadata is not populated for served files. This is why the direct `file://` URI workaround is in place.
- **Currently a no-op in the perception path.** NVStreamer starts and stays healthy but is not called by the upload handler.

## Related plan items

<!-- TODO: confirm — NVStreamer may be dropped or replaced with MediaMTX in a future RTSP-streaming phase -->
- [Locked decision D4 — Upload-only; RTSP deferred](../../../V1_PLAN.md#locked-decisions)
- [Deferred — Live (non-batch) incident detection on RTSP streams](../../../V1_PLAN.md#deferred-not-blocking-v1-demo)
