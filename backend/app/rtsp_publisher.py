"""Per-upload ffmpeg subprocess manager.

Spawns an ffmpeg process that reads a local video file in real-time and
publishes it as an RTSP stream to the mediamtx relay.  Each upload gets
its own process identified by ``video_id``.

Public API
----------
start(video_id, file_path) -> str
    Spawn ffmpeg for *video_id* → returns the RTSP URL.
stop(video_id) -> None
    SIGTERM the process; wait up to 5 s.
is_alive(video_id) -> bool
    True if the process exists and has not yet exited.
"""

import asyncio
import logging
import os
import subprocess
import threading
from pathlib import Path

import httpx

MEDIAMTX_URL = os.getenv("MEDIAMTX_URL", "rtsp://mediamtx:8554")
MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997")
log = logging.getLogger(__name__)

_publishers: dict[str, subprocess.Popen] = {}
_lock = threading.Lock()


def start(video_id: str, file_path: Path) -> str:
    """Spawn ``ffmpeg`` and stream *file_path* to mediamtx as RTSP.

    If a process for *video_id* is already running it is stopped first.

    Returns the RTSP URL the stream is published on.
    """
    rtsp_url = f"{MEDIAMTX_URL}/{video_id}"

    with _lock:
        _stop_locked(video_id)

        cmd = [
            "ffmpeg",
            "-re",
            "-stream_loop", "-1",
            "-i", str(file_path),
            "-c", "copy",
            "-f", "rtsp",
            rtsp_url,
        ]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _publishers[video_id] = proc
        log.info(
            "rtsp_publisher.start",
            extra={"video_id": video_id, "rtsp_url": rtsp_url, "pid": proc.pid},
        )

    return rtsp_url


def stop(video_id: str) -> None:
    """SIGTERM the ffmpeg process for *video_id* and remove it from the registry."""
    with _lock:
        _stop_locked(video_id)


def is_alive(video_id: str) -> bool:
    """Return ``True`` if the process exists and has not yet exited."""
    with _lock:
        proc = _publishers.get(video_id)
        if proc is None:
            return False
        return proc.poll() is None


async def wait_until_publishing(
    video_id: str, timeout_s: float = 10.0, poll_interval_s: float = 0.3
) -> bool:
    """Poll the mediamtx HTTP API until path *video_id* has an active publisher.

    Returns ``True`` when ``sourceReady`` (or ``ready`` on older builds) is true
    for the path; ``False`` if *timeout_s* elapses without the path coming up.

    Without this readiness check, DeepStream's ``stream/add`` races against the
    ffmpeg→mediamtx handshake and gets RTSP 404, crashing the DS pipeline (see
    F2 e2e transcript af686fec4702b92f0).
    """
    url = f"{MEDIAMTX_API_URL}/v3/paths/get/{video_id}"
    deadline = asyncio.get_event_loop().time() + timeout_s
    async with httpx.AsyncClient(timeout=2) as client:
        while True:
            try:
                resp = await client.get(url)
                if resp.status_code == 401:
                    # mediamtx authInternalUsers doesn't grant action:api.
                    # Don't waste 10s timing out — this is a config bug.
                    raise RuntimeError(
                        "mediamtx HTTP API returned 401 — add `action: api` to "
                        "authInternalUsers in mediamtx.yml"
                    )
                if resp.status_code == 200:
                    data = resp.json()
                    # mediamtx v1.x reports `sourceReady` (bool) or `ready` (legacy)
                    if data.get("sourceReady") or data.get("ready"):
                        log.info(
                            "rtsp_publisher.publishing",
                            extra={"video_id": video_id},
                        )
                        return True
            except RuntimeError:
                raise
            except Exception as e:
                log.debug(
                    "rtsp_publisher.poll.transient",
                    extra={"video_id": video_id, "error": str(e)},
                )
            if asyncio.get_event_loop().time() >= deadline:
                log.warning(
                    "rtsp_publisher.publishing.timeout",
                    extra={"video_id": video_id, "timeout_s": timeout_s},
                )
                return False
            await asyncio.sleep(poll_interval_s)


# ---------------------------------------------------------------------------
# Internal helpers (must be called with _lock held)
# ---------------------------------------------------------------------------

def _stop_locked(video_id: str) -> None:
    proc = _publishers.pop(video_id, None)
    if proc is None:
        return
    if proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception as e:
            log.warning(
                "rtsp_publisher.stop.failed",
                extra={"video_id": video_id, "error": str(e)},
            )
    log.info("rtsp_publisher.stop", extra={"video_id": video_id, "pid": proc.pid})
