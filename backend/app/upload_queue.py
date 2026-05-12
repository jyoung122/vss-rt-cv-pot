"""Upload job queue with concurrent GPU-stream admission control.

Up to ``MAX_CONCURRENT_STREAMS`` uploads process concurrently; each owns its
own plateau watcher and teardown.  A semaphore caps the number of in-flight
``_process_job`` coroutines so NVStreamer / DeepStream are never over-subscribed.

Data flow per job (F2):
  1. rtsp_publisher.start(video_id, file_path)          → publisher_url (mediamtx)
  2. nvstreamer.register_sensor(video_id, publisher_url) → sensor_uuid
     (Metadata-only — NVStreamer's RTSP re-stream is broken in this image.)
  3. deepstream.add_stream(video_id, publisher_url)
     DS pulls directly from mediamtx; NVStreamer's proxy URL returns 404 in
     this deployment (e2e test af648745d702108c9, spike ae44e238b57ba49ec).
  4. plateau watcher polls events WHERE video_id=$1 per job
  5. on plateau / hard timeout / exception:
     a. deepstream.remove_stream(video_id)
     b. nvstreamer.unregister_sensor(sensor_uuid)
     c. rtsp_publisher.stop(video_id)
     d. semaphore.release()
     e. q.task_done()
"""

import asyncio
import logging
import os
import time

from app import deepstream, nvstreamer, rtsp_publisher

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

UPLOAD_QUEUE_MAX_DEPTH: int = int(os.getenv("UPLOAD_QUEUE_MAX_DEPTH", "10"))
MAX_CONCURRENT_STREAMS: int = int(os.getenv("MAX_CONCURRENT_STREAMS", "2"))
DATA_DIR = os.getenv("DATA_DIR", "/data")
REDIS_URL = "redis://{}:{}".format(
    os.getenv("REDIS_HOST", "redis"), os.getenv("REDIS_PORT", "6379")
)


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

# _queue and _semaphore are lazily initialised on first use so they bind to
# the running event loop (important for tests that create a fresh loop per
# test case).
_queue: asyncio.Queue | None = None
_semaphore: asyncio.Semaphore | None = None
_active_job_ids: set[str] = set()
_worker_task: asyncio.Task | None = None


def _get_queue() -> asyncio.Queue:
    """Return the module-level queue, creating it if necessary."""
    global _queue
    if _queue is None:
        _queue = asyncio.Queue()
    return _queue


def _get_semaphore() -> asyncio.Semaphore:
    """Return the module-level semaphore, creating it if necessary."""
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(MAX_CONCURRENT_STREAMS)
    return _semaphore


def _reset_queue_for_testing() -> None:
    """Replace queue + semaphore with fresh instances for the current event loop.
    Only for use in tests."""
    global _queue, _semaphore, _active_job_ids
    _queue = asyncio.Queue()
    _semaphore = asyncio.Semaphore(MAX_CONCURRENT_STREAMS)
    _active_job_ids = set()


# ---------------------------------------------------------------------------
# Public accessors
# ---------------------------------------------------------------------------


def get_active_job_ids() -> frozenset[str]:
    """Return the set of video_ids currently being processed."""
    return frozenset(_active_job_ids)


def get_active_job_id() -> str | None:
    """Return an arbitrary active video_id, or None.

    For N=1 this is the active job.  For N>1 it returns one of the active
    jobs — callers that need the full set should use get_active_job_ids().
    uploads_list.py uses this to check whether a specific video_id is active;
    that call-site compares the returned value against its own video_id, so
    returning an arbitrary id is acceptable (it will fail the equality check
    for the other concurrent job, which is correct).
    """
    return next(iter(_active_job_ids), None)


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

    # If there are open semaphore slots and the queue was empty before us,
    # this job will be picked up immediately.
    if len(_active_job_ids) < MAX_CONCURRENT_STREAMS and depth == 0:
        queue_status = "active"
    else:
        queue_status = "queued"

    log.info(
        "upload_queue.job.enqueued",
        extra={"video_id": video_id, "position": position, "depth": depth + 1},
    )
    return {"queue_status": queue_status, "queue_position": position}


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


async def _process_job(job: dict, pool, sem: asyncio.Semaphore) -> None:
    """Execute one upload job end-to-end.

    The semaphore slot is released in the finally block after all teardown
    completes, so the next job never starts before GPU-side resources are freed.
    """
    video_id: str = job["video_id"]
    file_path: str = job["file_path"]
    ext: str = job["ext"]

    _active_job_ids.add(video_id)
    job_start = time.monotonic()

    log.info("upload_queue.job.active", extra={"video_id": video_id})

    sensor_uuid: str | None = None
    publisher_url: str | None = None
    stream_url: str | None = None

    try:
        # 1. Start RTSP publisher (ffmpeg → mediamtx) and wait until mediamtx
        #    reports the path is publishing. Without this, DeepStream races
        #    the ffmpeg session setup and gets RTSP 404 (e2e af686fec4702b92f0).
        publisher_url = rtsp_publisher.start(video_id, file_path)
        if not await rtsp_publisher.wait_until_publishing(video_id, timeout_s=10.0):
            raise RuntimeError(
                f"mediamtx did not report path {video_id} publishing within 10s"
            )

        # 3. Register with NVStreamer (sensor metadata only — its proxy doesn't
        #    actually serve in this image; DS pulls from mediamtx directly).
        sensor_uuid = await nvstreamer.register_sensor(
            name=video_id, rtsp_url=publisher_url
        )

        # 4. DeepStream consumes the mediamtx URL directly.
        #    NVStreamer's proxy URL (rtsp://nvstreamer:30554/live/<uuid>) returns
        #    404 in this deployment — the sensor registers, NVStreamer extracts
        #    codec metadata via GStreamer DESCRIBE, but the re-stream is never
        #    served (confirmed in the F2 e2e test af648745d702108c9 and the
        #    Path B spike ae44e238b57ba49ec). Mediamtx serves cleanly, so DS
        #    pulls from there directly; the NVStreamer sensor registration above
        #    is kept for observability + future-proofing only.
        stream_url = publisher_url

        # 5. Add source to DeepStream nvmultiurisrcbin via nvds_rest_server
        await deepstream.add_stream(video_id, stream_url)

        await pool.execute(
            "UPDATE uploads SET dss_status='processing' WHERE video_id=$1", video_id
        )

        # 6. Wait for ingest plateau OR hard timeout
        row = await pool.fetchrow(
            "SELECT duration_s FROM uploads WHERE video_id=$1", video_id
        )
        duration_s: float = (row["duration_s"] if row and row["duration_s"] else 0.0)

        arm_after = min(15.0, duration_s)
        # DeepStream continues emitting detections for ~25–30s past file EOS
        # (decoder/tracker tail-flush). Empirically a 148s clip finished at
        # t=175.8s, ~27s past EOS (e2e aae924d3c18590a51). Give a 60s buffer
        # so plateau detection has room to fire before this safety cap.
        hard_cap = duration_s + 60.0
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
            extra={
                "video_id": video_id,
                "total_ms": duration_ms,
                "dss_status": final_status,
            },
        )

    except Exception:
        log.error(
            "upload_queue.job.error",
            extra={"video_id": video_id},
            exc_info=True,
        )
        try:
            await pool.execute(
                "UPDATE uploads SET dss_status='failed' WHERE video_id=$1", video_id
            )
        except Exception:
            log.error(
                "upload_queue.job.db_update_failed",
                extra={"video_id": video_id},
                exc_info=True,
            )

    finally:
        # F4 teardown — order matters; each step is guarded so one failure
        # doesn't skip the rest.
        if stream_url is not None:
            await deepstream.remove_stream(video_id, stream_url)  # never raises

        if sensor_uuid is not None:
            await nvstreamer.unregister_sensor(sensor_uuid)  # never raises

        rtsp_publisher.stop(video_id)                     # no-op if never started

        _active_job_ids.discard(video_id)
        sem.release()
        _get_queue().task_done()


async def _worker_loop(pool, sem: asyncio.Semaphore) -> None:
    """Main worker loop — dequeues jobs and fans them out up to sem capacity."""
    log.info("upload_queue.worker.start")
    q = _get_queue()
    running_tasks: list[asyncio.Task] = []

    while True:
        try:
            await sem.acquire()           # blocks when MAX_CONCURRENT_STREAMS tasks running
        except asyncio.CancelledError:
            log.info("upload_queue.worker.cancelled")
            # Cancel all in-flight jobs so their finally blocks fire teardown
            for t in running_tasks:
                t.cancel()
            if running_tasks:
                await asyncio.gather(*running_tasks, return_exceptions=True)
            return

        try:
            job = await q.get()
        except asyncio.CancelledError:
            sem.release()
            log.info("upload_queue.worker.cancelled")
            for t in running_tasks:
                t.cancel()
            if running_tasks:
                await asyncio.gather(*running_tasks, return_exceptions=True)
            return

        task = asyncio.create_task(_process_job(job, pool, sem))
        running_tasks.append(task)
        # Prune completed tasks from the list to avoid unbounded growth
        running_tasks = [t for t in running_tasks if not t.done()]


# ---------------------------------------------------------------------------
# Lifecycle helpers (called from main.py lifespan)
# ---------------------------------------------------------------------------


def start_worker(pool) -> asyncio.Task:
    """Start the background worker task. Returns the task."""
    global _worker_task
    sem = _get_semaphore()
    _worker_task = asyncio.create_task(_worker_loop(pool, sem))
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
