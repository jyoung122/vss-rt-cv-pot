"""In-process serial upload job queue.

Single asyncio worker processes one upload at a time so concurrent demo users
don't race on the global Redis key / stream-URL file / DeepStream container.
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

UPLOAD_QUEUE_MAX_DEPTH: int = int(os.getenv("UPLOAD_QUEUE_MAX_DEPTH", "10"))
DATA_DIR = os.getenv("DATA_DIR", "/data")
REDIS_URL = "redis://{}:{}".format(
    os.getenv("REDIS_HOST", "redis"), os.getenv("REDIS_PORT", "6379")
)
DOCKER_SOCK = "/var/run/docker.sock"


# ---------------------------------------------------------------------------
# Typed exception
# ---------------------------------------------------------------------------


class QueueFull(Exception):
    """Raised by enqueue() when the queue is at max depth."""

    def __init__(self, depth: int) -> None:
        super().__init__(f"Queue full (depth={depth})")
        self.depth = depth


# ---------------------------------------------------------------------------
# Queue state
# ---------------------------------------------------------------------------

# _queue is lazily initialised on first use so it binds to the running event
# loop (important for tests that create a fresh loop per test case).
_queue: asyncio.Queue | None = None
_active_job_id: str | None = None
_worker_task: asyncio.Task | None = None


def _get_queue() -> asyncio.Queue:
    """Return the module-level queue, creating it if necessary."""
    global _queue
    if _queue is None:
        _queue = asyncio.Queue()
    return _queue


def _reset_queue_for_testing() -> None:
    """Replace the queue with a fresh one bound to the current event loop.
    Only for use in tests."""
    global _queue
    _queue = asyncio.Queue()


# ---------------------------------------------------------------------------
# Public accessors
# ---------------------------------------------------------------------------


def get_active_job_id() -> str | None:
    return _active_job_id


def get_queue_depth() -> int:
    return _get_queue().qsize()


def get_queue_position(video_id: str) -> int | None:
    """Return 0-indexed position in the queue, or None if not found."""
    q = _get_queue()
    for idx, job in enumerate(list(q._queue)):  # type: ignore[attr-defined]
        if job["video_id"] == video_id:
            return idx
    return None


def enqueue(video_id: str, file_path: str, ext: str) -> dict:
    """Add a job to the queue.

    Returns a dict with ``queue_status`` and ``queue_position``.
    Raises :class:`QueueFull` if the queue is at max depth.
    """
    q = _get_queue()
    depth = q.qsize()
    if depth >= UPLOAD_QUEUE_MAX_DEPTH:
        log.warning("upload_queue.queue.full", extra={"depth": depth})
        raise QueueFull(depth)

    job = {"video_id": video_id, "file_path": file_path, "ext": ext}
    q.put_nowait(job)

    # Position after enqueueing: depth before was the index (0-based).
    position = depth  # 0 if queue was empty

    # If the worker has nothing active and the queue was empty before us,
    # this job will be picked up immediately.
    if _active_job_id is None and depth == 0:
        queue_status = "active"
    else:
        queue_status = "queued"

    log.info(
        "upload_queue.job.enqueued",
        extra={"video_id": video_id, "position": position, "depth": depth + 1},
    )
    return {"queue_status": queue_status, "queue_position": position}


# ---------------------------------------------------------------------------
# Docker helpers (moved here as the single source of truth)
# ---------------------------------------------------------------------------


async def _docker_api(method: str, path: str, body: dict | None = None) -> int:
    """Call Docker Engine API via unix socket. Returns HTTP status code."""
    cmd = [
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-X", method, "--unix-socket", DOCKER_SOCK,
        f"http://localhost{path}",
    ]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    try:
        return int(stdout.decode().strip())
    except ValueError:
        return 0


async def _restart_container(name: str) -> None:
    status = await _docker_api("POST", f"/containers/{name}/restart?t=5")
    if status not in (204, 304):
        log.warning(
            "docker.container.restart.degraded",
            extra={"container": name, "status_code": status},
        )


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


async def _process_job(job: dict, pool) -> None:
    """Execute one upload job: redis-set → url-file → restart → wait plateau."""
    global _active_job_id

    import redis.asyncio as aioredis

    video_id: str = job["video_id"]
    file_path: str = job["file_path"]
    ext: str = job["ext"]

    _active_job_id = video_id
    job_start = time.monotonic()

    log.info("upload_queue.job.active", extra={"video_id": video_id, "wait_ms": 0})

    try:
        stream_url = f"file:///data/videos/{video_id}{ext}"

        # 1. Set current_video_id in Redis
        r = aioredis.from_url(REDIS_URL, decode_responses=True)
        async with r:
            await r.set("current_video_id", video_id)

        # 2. Write stream URL file for ds-start.sh
        url_file = Path(DATA_DIR) / "videos" / "current_stream_url.txt"
        url_file.parent.mkdir(parents=True, exist_ok=True)
        url_file.write_text(stream_url)

        # 3. Restart vss-rt-cv
        await _restart_container("vss-rt-cv")
        await pool.execute(
            "UPDATE uploads SET dss_status='processing' WHERE video_id=$1", video_id
        )

        # 4. Wait for ingest plateau OR hard timeout
        row = await pool.fetchrow(
            "SELECT duration_s FROM uploads WHERE video_id=$1", video_id
        )
        duration_s: float = (row["duration_s"] if row and row["duration_s"] else 0.0)

        arm_after = min(15.0, duration_s)
        hard_cap = duration_s + 30.0
        elapsed = 0.0
        armed = False
        consecutive = 0
        last_count: int | None = None
        PLATEAU_CONSECUTIVE = 3
        plateau_reached = False

        while elapsed < hard_cap:
            await asyncio.sleep(1.0)
            elapsed += 1.0

            count: int = await pool.fetchval(
                "SELECT count(*) FROM events WHERE video_id=$1", video_id
            )

            if not armed and elapsed >= arm_after:
                armed = True

            if armed:
                if count == last_count:
                    consecutive += 1
                else:
                    consecutive = 0
                last_count = count

                if consecutive >= PLATEAU_CONSECUTIVE:
                    plateau_reached = True
                    duration_ms = int((time.monotonic() - job_start) * 1000)
                    log.info(
                        "upload_queue.job.plateau",
                        extra={
                            "video_id": video_id,
                            "event_count": count,
                            "duration_ms": duration_ms,
                        },
                    )
                    break
            else:
                last_count = count

        final_status = "completed" if plateau_reached else "failed"
        await pool.execute(
            "UPDATE uploads SET dss_status=$1 WHERE video_id=$2", final_status, video_id
        )
        duration_ms = int((time.monotonic() - job_start) * 1000)
        log.info(
            "upload_queue.job.done",
            extra={"video_id": video_id, "total_ms": duration_ms, "dss_status": final_status},
        )

    except Exception:
        log.error(
            "upload_queue.job.error",
            extra={"video_id": video_id},
            exc_info=True,
        )
        await pool.execute(
            "UPDATE uploads SET dss_status='failed' WHERE video_id=$1", video_id
        )
    finally:
        _active_job_id = None


async def _worker_loop(pool) -> None:
    """Main worker loop — runs forever until cancelled."""
    log.info("upload_queue.worker.start")
    q = _get_queue()
    while True:
        try:
            job = await q.get()
        except asyncio.CancelledError:
            log.info("upload_queue.worker.cancelled")
            return

        try:
            await _process_job(job, pool)
        except asyncio.CancelledError:
            q.task_done()
            log.info("upload_queue.worker.cancelled")
            return
        except Exception:
            log.exception(
                "upload_queue.job.outer_error",
                extra={"video_id": job.get("video_id", "unknown")},
            )
        q.task_done()


# ---------------------------------------------------------------------------
# Lifecycle helpers (called from main.py lifespan)
# ---------------------------------------------------------------------------


def start_worker(pool) -> asyncio.Task:
    """Start the background worker task. Returns the task."""
    global _worker_task
    _worker_task = asyncio.create_task(_worker_loop(pool))
    return _worker_task


async def stop_worker() -> None:
    """Cancel and await the worker task."""
    global _worker_task
    if _worker_task is not None:
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        _worker_task = None
