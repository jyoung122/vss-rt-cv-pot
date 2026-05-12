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

import logging
import os
import subprocess
import threading
from pathlib import Path

MEDIAMTX_URL = os.getenv("MEDIAMTX_URL", "rtsp://mediamtx:8554")
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
