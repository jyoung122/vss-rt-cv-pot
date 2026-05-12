# 2026-05-12 — NVStreamer re-diagnosis + multi-user/parallel architecture decision

**Host:** Fresh AWS EC2 `g6e.xlarge` was unavailable (no capacity in any us-west-2 AZ), fell back to `g6.xlarge` (1× L4 24 GB, DLAMI Ubuntu 22.04, driver 580.126.09). One-off diagnostic instance, torn down after.

**Goal:** Validate whether the long-standing "NVStreamer 3.1.0 is upstream broken" verdict from the 2026-04-30 archived gotcha was correct, before committing to remove NVStreamer/SDR from v1. The answer matters because the demo needs multi-user uploads + parallel GPU processing, and the original gotcha was driving us toward a bespoke source-controller that would diverge from VSS.

## TL;DR

The original "upstream broken" verdict was **wrong in framing but right that NVStreamer's file-streamer path is unusable in this image.** The bug is narrower than claimed: NVStreamer 3.1.0's container ships a launch_vst binary compiled against libav60 with the entire FFmpeg runtime dep chain (~30+ libs) stripped from the rootfs. The file-streamer code path (`liblocalstreams.so` + `getMediaInformationUsingLibav`) hits the stripped libs and fails; the RTSP-camera path doesn't. VSS works because VSS uses cameras, not files.

**Decision:** Keep NVStreamer in the architecture, but only via the RTSP path. Wrap uploaded files in a tiny file→RTSP shim, register them with NVStreamer as camera sources. This is the path NVStreamer is actually tested by NVIDIA, doesn't require patching the broken image, and unblocks Phase F (multi-user + parallel) on the canonical VSS architecture.

## What the team observed on 2026-04-30 (archived gotcha)

| Observation | Recorded conclusion |
|---|---|
| `POST /api/v1/file` returns 404 | "NVStreamer 3.1.0 metadata discovery is broken" |
| RTSP DESCRIBE returns 404; logs show `Container:`, `videoCodec:` empty | "Affects every file format we tried (mp4, h264, with/without audio, baseline profile, +faststart)" |
| Worked around by writing `file:///data/videos/...` directly to `current_stream_url.txt` and consuming via DeepStream `uridecodebin` | NVStreamer + SDR declared cosmetic; queued behind hypothetical NVStreamer 3.2.0 |

## What's actually true

Verified on the EC2 diagnostic box with the project's `nvstreamer/configs/adaptor_config.json` mounted (streamer adapter `enabled:true`) and a real-world H.264 High Profile 1280×720 traffic-cam mp4 (`data/videos/79_Cactus.mp4` copied as `realistic.mp4`):

1. **`POST /api/v1/file` doesn't exist.** Not "broken" — never existed. The real NVStreamer API surface (extracted from the bundled web UI's JS bundle):

   ```
   POST /api/v1/sensor/add               register a camera/source
   GET  /api/v1/sensor/list, /scan, /status, /configuration, /streams, /qos
   GET  /api/v1/storage/file?sensor_id=X
   GET  /api/v1/storage/file/mediainfo
   GET  /api/v1/storage/timelines
   WS   /api/v1/replay/ws, /api/v1/streambridge/ws
   ```

2. **File auto-discovery works** when the streamer adapter is enabled. `realistic.mp4` registered as `sensorId=realistic_0`, state `online`, was assigned a proxy RTSP URL, and emitted a log line:

   ```
   [fs_utils.cpp:254: getVideoFiles]     Found video file: ...streamer_videos/realistic.mp4
   [local_streams.cpp:242: addLocalStreams]  rtsp://172.17.0.2:30554/nvstream/...realistic.mp4
   ```

3. **The libav probe fails — and only the file path uses it.** The metadata extraction code in `mm_utils.cpp:getMediaInformationUsingLibav` is invoked by `addLocalStreams` (file path) but NOT by the RTSP-source path. The failure mode:

   ```
   [INFO] LibavWrapper: Initializing dynamic libav loading
   [INFO] LibavWrapper: Successfully loaded library from: libavutil.so.58.29.100
   [ERROR] LibavWrapper: Failed to load libav libraries dynamically
   ```

   `LD_DEBUG=files` traced the actual failure: `prebuilts/x86_64/libmmutils.so` dlopens `libavformat.so.60.16.100`, which fails because the dep chain is missing in the container:

   ```
   libgme.so.0, libopenmpt.so.0, libchromaprint.so.1, libbluray.so.2,
   librabbitmq.so.4, librist.so.4, libsrt-gnutls.so.1.5, libssh-gcrypt.so.4,
   libzmq.so.5, libvpx.so.9, libx264.so.164, libx265.so.199, libxvidcore.so.4,
   libzvbi.so.0, libmpg123.so.0, libFLAC.so.12, libbs2b.so.0, libcdio.so.19,
   libmp3lame.so.0  (and more)
   ```

   All are standard Ubuntu 24.04 packages whose `.so` files were stripped from the rootfs, but whose dpkg metadata was left behind (so `apt install` no-ops and `apt install --reinstall` is required to put them back). Each install iteration uncovered another 4–6 missing transitive deps. After 4 rounds of dep installs we were still uncovering more. Whack-a-mole.

4. **NVStreamer 3.0.0 has the same bug.** Tested separately — same Ubuntu 24.04 base, same stripped libs, same RTSP DESCRIBE 404. No 22.04-based variant of NVStreamer exists on NGC (`skopeo list-tags` confirms only `3.0.0` and `3.1.0`, both labeled `image.version: 24.04`).

5. **The RTSP path works.** Set up `mediamtx` on the host serving `realistic.mp4` as `rtsp://localhost:8554/stream` via a looped `ffmpeg` publisher. POSTed `{"name":"cam1","sensorUrl":"rtsp://172.17.0.1:8554/stream","location":"test","tags":"","username":"","password":""}` to `/api/v1/sensor/add`. NVStreamer:

   ```
   Codec: H264                                                  ← populated, vs empty for the file path
   width="1280" height="720" fps="15.000000"                    ← extracted via GStreamer RTSP DESCRIBE, not libav
   Stream status: stream_streaming                              ← vs error 2 for the file path
   Live proxy url: rtsp://172.17.0.2:30554/live/<uuid>          ← clean proxy URL
   Replay url:    rtsp://172.17.0.2:30574/vod/<uuid>
   ```

   The probe path here is `gst_utils.cpp:getRTSPStreamDetails`, which uses GStreamer's RTSP client (not libav). No FFmpeg runtime needed.

## Why VSS works

VSS's primary use case is live cameras over ONVIF/RTSP. Cameras self-describe via RTSP DESCRIBE / SDP — no local file probe needed. The `vst` and `mms` adapter types in `adaptor_config.json` (ONVIF / Milestone VMS) bypass the libav path entirely. NVIDIA never exercised the `streamer` adapter at the same intensity, so the broken-deps regression in 3.1.0 didn't surface for them. Our deploy is the unusual one — we enabled `streamer` because we want to ingest uploaded MP4s, which is exactly the path NVIDIA broke.

## Architecture decision

**Use NVStreamer via the RTSP path.** When a user uploads a file:

```
1. Backend writes <id>.mp4 to /data/videos/
2. Backend ensures a mediamtx instance is running (single shared instance, not per-file)
3. Backend launches a looped ffmpeg publisher: ffmpeg -re -stream_loop -1 -i <file> -c copy -f rtsp rtsp://mediamtx:8554/<id>
4. Backend POSTs to NVStreamer: /api/v1/sensor/add with sensorUrl pointing to that mediamtx URL
5. NVStreamer returns a sensorId + proxy RTSP URL
6. Backend registers that proxy URL with SDR (or DeepStream directly)
7. DeepStream nvstreammux adds the source dynamically — no container restart
8. Events stream out tagged with sensorId
9. After plateau / hard timeout, backend unregisters sensor + kills the ffmpeg publisher
```

Concurrency: backend holds a semaphore (`MAX_CONCURRENT_STREAMS`, default 2, tune up after the F5 capacity probe).

Per-user fairness: round-robin per-user sub-queues feed into the semaphore (Phase F6 — only matters once Phase A multi-user data isolation lands).

## What's no longer needed

- **`current_stream_url.txt` + container restart** ([backend/app/upload_queue.py:184-190](../../../backend/app/upload_queue.py#L184-L190)) — dynamic source add via SDR/NVStreamer replaces this entirely
- **`remove_active_stream()` before every register** ([backend/app/upload.py:206-207](../../../backend/app/upload.py#L206-L207)) — replaced by `unregister_stream(sensorId)` after plateau / timeout
- **The `current_video_id` Redis singleton** read by `event_indexer.py:154` — events will carry `sensorId` per the F1 spike

## What needs to be true for this to work (open questions)

- **F1 spike confirmation:** DeepStream's msgconv must populate `sensorId` (or equivalent) in the `mdx-raw` payload so the indexer can route events by source. Probably true given the multi-sensor pipeline design, but unverified in our config. ~½ day to confirm.
- **mediamtx-on-host networking:** NVStreamer container is on Docker bridge, mediamtx needs to be reachable from inside. Either run mediamtx as a compose service on the same network, or bind it to the host gateway IP (`172.17.0.1` works from the bridge). Compose service is cleaner.
- **Loop-publishing CPU cost:** Each upload is a ~few-min ffmpeg looped publisher. With `-c copy` (no re-encode) cost is trivial — single-digit % CPU per stream. At N=4 concurrent, should be invisible compared to DeepStream's GPU load.
- **`POST /api/v1/sensor/add` payload schema:** Validated above. Required fields: `name`, `sensorUrl`, `location`, `tags` (string, not array — array crashes the server), `username`, `password`. Returns `{"sensorId": "<uuid>"}`.
- **SDR ↔ DeepStream handoff:** Not directly tested today. Either SDR registration genuinely forwards to DeepStream nvstreammux (the documented VSS architecture), or we need a small bridge. ~½ day to verify or implement.

## Revised effort estimate for the demo

| Phase | Work | Effort |
|---|---|---|
| A — Data isolation (backend) | already implemented in working tree, uncommitted | done, needs commit |
| F0 — File-to-RTSP shim layer | mediamtx as compose service, per-upload ffmpeg publisher controlled by backend | ~½ day |
| F1 — Verify sensorId in mdx-raw + rewrite indexer | spike + indexer refactor | ~1 day |
| F2 — Backend semaphore + admission control | replace single-worker with N coroutines, drop `current_stream_url.txt`, drop container restart | ~½ day |
| F3 — Per-video plateau watcher | already per-video, just runs N in parallel | ~¼ day |
| F4 — SDR / NVStreamer cleanup (unregister on plateau/timeout) | `unregister_stream(sensorId)` + ffmpeg publisher teardown | ~½ day |
| F5 — Capacity probe | sweep N=1..4 on L40S/A10G, set production default | ~½ day |
| C — Frontend polish (signed-in chip, 401 toast) | UI work | ~½ day |
| D — Doc reconciliation | this log + Phase F revisions | ~1 hr |
| **Total** | | **~3.5–4 days focused** |

The "smallest demo-able slice" remains A + D, but the demo target (multi-user + parallel) needs A + F0 + F1 + F2 + F4. Roughly a focused week to get the full feature shipped.

## Things to do in this session (followups, not yet done)

- [ ] Commit Phase A (already implemented in working tree)
- [ ] Update `docs/v1/services/nvstreamer/README.md` "Known issues" — replace the upstream-broken claim with the correct narrow diagnosis (file-streamer adapter unusable in 3.1.0; RTSP path works fine; that's the demo path)
- [ ] Annotate `docs/v1/archive/FUTURE_STATE_POT_ARCHIVED.md:202` as superseded with link to this log
- [ ] Update `docs/v1/phases/multi-user-uploads.md` Phase F section — pivot the F2 wording from "remove `current_stream_url.txt` + container restart, rely on SDR" to "wire backend → mediamtx + NVStreamer RTSP path → SDR → DeepStream dynamic add"
- [ ] Tear down EC2 box (`i-0cf217cecca8d1b95`, sg `sg-0e75916de12c66ecf`)

## Test artifacts

All produced on EC2 box `i-0cf217cecca8d1b95` (us-west-2, public IP `35.92.144.242`, destroyed after the session). The box state included:

- `/tmp/aims-test/videos/sample.mp4` — synthetic 720p H.264 baseline + AAC, faststart (lavfi testsrc, 5s, 166 KB)
- `/tmp/aims-real/realistic.mp4` — copy of `data/videos/79_Cactus.mp4` (1280×720, 15fps H.264 High, 11 MB, real traffic cam)
- `/tmp/adaptor_config.json` — our repo's config with streamer adapter enabled
- `/tmp/libav58/` — Ubuntu 22.04 libav58 .so files extracted from `ubuntu:22.04` base image (test for soname matching — confirmed launch_vst wants .so.60, not .so.58)
- `/tmp/ffdeps/` — Ubuntu 24.04 .so files for the dep-chain we tried to repair
- NVStreamer 3.1.0 image pulled fresh and re-pulled with `LD_DEBUG=files` for dlopen tracing
- mediamtx + ffmpeg looped publisher for the RTSP-path validation

Total EC2 spend: ~$1.50.

## Related

- [docs/v1/services/nvstreamer/README.md](../../v1/services/nvstreamer/README.md) — superseded by this log
- [docs/v1/archive/FUTURE_STATE_POT_ARCHIVED.md:202](../../v1/archive/FUTURE_STATE_POT_ARCHIVED.md#L202) — superseded by this log
- [docs/v1/phases/multi-user-uploads.md](../../v1/phases/multi-user-uploads.md) — Phase F section to be updated per architecture decision above
