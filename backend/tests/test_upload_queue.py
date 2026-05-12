"""Unit tests for the upload_queue module.

Uses the same _stub_app_imports() pattern as test_uploads_progress.py so
the module can be imported without FastAPI / asyncpg installed.
"""

import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch, call


# ---------------------------------------------------------------------------
# Stub out app-level dependencies before importing the module under test
# ---------------------------------------------------------------------------

def _stub_app_imports():
    if "app" not in sys.modules:
        sys.modules["app"] = types.ModuleType("app")

    # app.db
    if "app.db" not in sys.modules:
        db_stub = types.ModuleType("app.db")
        db_stub.get_pool = lambda: None
        sys.modules["app.db"] = db_stub

    # app.nvstreamer
    if "app.nvstreamer" not in sys.modules:
        nv_stub = types.ModuleType("app.nvstreamer")
        nv_stub.register_sensor = AsyncMock(return_value="stub-uuid")
        nv_stub.unregister_sensor = AsyncMock()
        nv_stub.get_proxy_url = AsyncMock(return_value=None)
        sys.modules["app.nvstreamer"] = nv_stub

    # app.rtsp_publisher
    if "app.rtsp_publisher" not in sys.modules:
        pub_stub = types.ModuleType("app.rtsp_publisher")
        pub_stub.start = MagicMock(return_value="rtsp://mediamtx:8554/vid")
        pub_stub.stop = MagicMock()
        pub_stub.is_alive = MagicMock(return_value=False)
        sys.modules["app.rtsp_publisher"] = pub_stub

    # app.deepstream
    if "app.deepstream" not in sys.modules:
        ds_stub = types.ModuleType("app.deepstream")
        ds_stub.add_stream = AsyncMock()
        ds_stub.remove_stream = AsyncMock()
        ds_stub.is_ready = AsyncMock(return_value=True)
        sys.modules["app.deepstream"] = ds_stub

    # redis.asyncio
    if "redis" not in sys.modules:
        redis_mod = types.ModuleType("redis")
        sys.modules["redis"] = redis_mod
    if "redis.asyncio" not in sys.modules:
        redis_async_mod = types.ModuleType("redis.asyncio")

        class _FakeRedis:
            """Minimal async context manager stub."""
            async def set(self, *a, **kw):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                pass

        redis_async_mod.from_url = lambda *a, **kw: _FakeRedis()
        sys.modules["redis.asyncio"] = redis_async_mod


_stub_app_imports()

# Now it is safe to import the module under test.
import backend.app.upload_queue as uq  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _reset_queue():
    """Reset global state between tests."""
    uq._queue = asyncio.Queue()
    uq._semaphore = asyncio.Semaphore(uq.MAX_CONCURRENT_STREAMS)
    uq._active_job_ids = set()


class _FakePool:
    """asyncpg-like pool stub."""

    def __init__(self, event_count: int = 0, duration_s: float = 5.0):
        self._event_count = event_count
        self._duration_s = duration_s
        self._fetchrow_row = {"duration_s": duration_s}
        self.execute = AsyncMock()

    async def fetchrow(self, sql, *args):
        return self._fetchrow_row

    async def fetchval(self, sql, *args):
        return self._event_count


# ---------------------------------------------------------------------------
# EnqueueTests
# ---------------------------------------------------------------------------

class EnqueueTests(unittest.TestCase):

    def setUp(self):
        _reset_queue()

    def tearDown(self):
        _reset_queue()

    def test_enqueue_empty_returns_active(self):
        """First job into an empty queue with open semaphore slots gets queue_status='active'."""
        result = uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        self.assertEqual(result["queue_status"], "active")
        self.assertEqual(result["queue_position"], 0)

    def test_enqueue_second_returns_queued(self):
        """Second concurrent job gets queue_status='queued', queue_position=1."""
        uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        result = uq.enqueue("vid2", "/data/videos/vid2.mp4", ".mp4")
        self.assertEqual(result["queue_status"], "queued")
        self.assertEqual(result["queue_position"], 1)

    def test_enqueue_full_raises(self):
        """When depth == UPLOAD_QUEUE_MAX_DEPTH, enqueue raises QueueFull."""
        original_max = uq.UPLOAD_QUEUE_MAX_DEPTH
        uq.UPLOAD_QUEUE_MAX_DEPTH = 2
        try:
            uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
            uq.enqueue("vid2", "/data/videos/vid2.mp4", ".mp4")
            with self.assertRaises(uq.QueueFull) as ctx:
                uq.enqueue("vid3", "/data/videos/vid3.mp4", ".mp4")
            self.assertEqual(ctx.exception.depth, 2)
        finally:
            uq.UPLOAD_QUEUE_MAX_DEPTH = original_max

    def test_get_position_unknown_returns_none(self):
        """Querying a video_id not in the queue returns None."""
        uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        result = uq.get_queue_position("vid_unknown")
        self.assertIsNone(result)

    def test_enqueue_when_active_slots_full_returns_queued(self):
        """When _active_job_ids is at capacity, first queued job still gets 'queued'."""
        original_max = uq.MAX_CONCURRENT_STREAMS
        uq.MAX_CONCURRENT_STREAMS = 1
        uq._active_job_ids = {"already-active"}
        try:
            result = uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
            self.assertEqual(result["queue_status"], "queued")
        finally:
            uq.MAX_CONCURRENT_STREAMS = original_max
            uq._active_job_ids = set()


# ---------------------------------------------------------------------------
# WorkerTests
# ---------------------------------------------------------------------------

class WorkerTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        _reset_queue()

    def tearDown(self):
        _reset_queue()

    async def test_worker_swallows_exceptions(self):
        """First job raises; worker advances; second job still runs."""
        processed = []

        async def fake_process_job(job, pool, sem):
            if job["video_id"] == "vid1":
                raise RuntimeError("simulated failure")
            processed.append(job["video_id"])
            sem.release()
            uq._get_queue().task_done()

        pool = _FakePool()
        uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        uq.enqueue("vid2", "/data/videos/vid2.mp4", ".mp4")

        sem = uq._get_semaphore()
        with patch.object(uq, "_process_job", side_effect=fake_process_job):
            task = asyncio.create_task(uq._worker_loop(pool, sem))
            await asyncio.sleep(0.3)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        self.assertIn("vid2", processed)

    async def test_concurrent_jobs_run_in_parallel(self):
        """With MAX_CONCURRENT_STREAMS=2, two jobs start before either finishes."""
        original_max = uq.MAX_CONCURRENT_STREAMS
        uq.MAX_CONCURRENT_STREAMS = 2
        _reset_queue()

        started = []
        finished = []
        gate = asyncio.Event()

        async def fake_process_job(job, pool, sem):
            started.append(job["video_id"])
            await gate.wait()   # both start before either finishes
            finished.append(job["video_id"])
            sem.release()
            uq._get_queue().task_done()

        pool = _FakePool()
        uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        uq.enqueue("vid2", "/data/videos/vid2.mp4", ".mp4")

        sem = uq._get_semaphore()
        try:
            with patch.object(uq, "_process_job", side_effect=fake_process_job):
                task = asyncio.create_task(uq._worker_loop(pool, sem))
                # Give both tasks time to start
                await asyncio.sleep(0.1)
                # Both should be started before gate opens
                self.assertIn("vid1", started)
                self.assertIn("vid2", started)
                self.assertEqual(len(finished), 0, "neither should have finished yet")
                # Let them finish
                gate.set()
                await asyncio.sleep(0.1)
                self.assertIn("vid1", finished)
                self.assertIn("vid2", finished)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        finally:
            uq.MAX_CONCURRENT_STREAMS = original_max
            _reset_queue()

    async def test_semaphore_blocks_at_capacity(self):
        """With MAX_CONCURRENT_STREAMS=1, second job does not start until first releases."""
        original_max = uq.MAX_CONCURRENT_STREAMS
        uq.MAX_CONCURRENT_STREAMS = 1
        _reset_queue()

        order = []
        release_first = asyncio.Event()

        async def fake_process_job(job, pool, sem):
            order.append(("start", job["video_id"]))
            if job["video_id"] == "vid1":
                await release_first.wait()
            order.append(("done", job["video_id"]))
            sem.release()
            uq._get_queue().task_done()

        pool = _FakePool()
        uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        uq.enqueue("vid2", "/data/videos/vid2.mp4", ".mp4")

        sem = uq._get_semaphore()
        try:
            with patch.object(uq, "_process_job", side_effect=fake_process_job):
                task = asyncio.create_task(uq._worker_loop(pool, sem))
                await asyncio.sleep(0.05)
                # vid1 started, vid2 blocked
                self.assertIn(("start", "vid1"), order)
                self.assertNotIn(("start", "vid2"), order)
                # Release vid1
                release_first.set()
                await asyncio.sleep(0.1)
                # vid2 should now have started and finished
                self.assertIn(("start", "vid2"), order)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        finally:
            uq.MAX_CONCURRENT_STREAMS = original_max
            _reset_queue()

    async def test_teardown_called_on_happy_path(self):
        """deepstream.remove_stream, nvstreamer.unregister_sensor, rtsp_publisher.stop called."""
        # Reset stubs to fresh mocks
        ds_mod = sys.modules["app.deepstream"]
        nv_mod = sys.modules["app.nvstreamer"]
        pub_mod = sys.modules["app.rtsp_publisher"]

        ds_mod.add_stream = AsyncMock()
        ds_mod.remove_stream = AsyncMock()
        nv_mod.register_sensor = AsyncMock(return_value="test-uuid")
        nv_mod.unregister_sensor = AsyncMock()
        nv_mod.get_proxy_url = AsyncMock(return_value=None)
        pub_mod.start = MagicMock(return_value="rtsp://mediamtx:8554/vid1")
        pub_mod.stop = MagicMock()

        # Use a pool that returns an event_count that causes plateau quickly
        pool = _FakePool(event_count=5, duration_s=1.0)

        job = {"video_id": "vid1", "file_path": "/data/videos/vid1.mp4", "ext": ".mp4"}
        sem = asyncio.Semaphore(1)
        await sem.acquire()
        # Put a token in the queue so task_done() doesn't raise
        uq._get_queue().put_nowait(job)
        _ = await uq._get_queue().get()

        await uq._process_job(job, pool, sem)

        ds_mod.remove_stream.assert_awaited_once_with("vid1")
        nv_mod.unregister_sensor.assert_awaited_once_with("test-uuid")
        pub_mod.stop.assert_called_once_with("vid1")
        # Semaphore should be released (can acquire again without blocking)
        self.assertTrue(sem._value >= 1 or not sem.locked())

    async def test_teardown_called_on_exception(self):
        """When register_sensor raises, remove_stream and rtsp_publisher.stop still called."""
        ds_mod = sys.modules["app.deepstream"]
        nv_mod = sys.modules["app.nvstreamer"]
        pub_mod = sys.modules["app.rtsp_publisher"]

        ds_mod.remove_stream = AsyncMock()
        nv_mod.register_sensor = AsyncMock(side_effect=RuntimeError("NVStreamer down"))
        nv_mod.unregister_sensor = AsyncMock()
        pub_mod.start = MagicMock(return_value="rtsp://mediamtx:8554/vid1")
        pub_mod.stop = MagicMock()

        pool = _FakePool()
        job = {"video_id": "vid2", "file_path": "/data/videos/vid2.mp4", "ext": ".mp4"}
        sem = asyncio.Semaphore(1)
        await sem.acquire()
        # Satisfy task_done() by pre-populating and consuming the queue
        uq._get_queue().put_nowait(job)
        _ = await uq._get_queue().get()

        await uq._process_job(job, pool, sem)

        # remove_stream always called in finally
        ds_mod.remove_stream.assert_awaited_once_with("vid2")
        # unregister_sensor NOT called (sensor_uuid was never set)
        nv_mod.unregister_sensor.assert_not_awaited()
        # rtsp_publisher.stop always called
        pub_mod.stop.assert_called_once_with("vid2")

    async def test_teardown_skips_unregister_when_rtsp_start_fails(self):
        """When rtsp_publisher.start raises, unregister_sensor is skipped."""
        ds_mod = sys.modules["app.deepstream"]
        nv_mod = sys.modules["app.nvstreamer"]
        pub_mod = sys.modules["app.rtsp_publisher"]

        ds_mod.remove_stream = AsyncMock()
        nv_mod.register_sensor = AsyncMock(return_value="should-not-be-called-uuid")
        nv_mod.unregister_sensor = AsyncMock()
        pub_mod.start = MagicMock(side_effect=RuntimeError("ffmpeg not found"))
        pub_mod.stop = MagicMock()

        pool = _FakePool()
        job = {"video_id": "vid3", "file_path": "/data/videos/vid3.mp4", "ext": ".mp4"}
        sem = asyncio.Semaphore(1)
        await sem.acquire()
        # Satisfy task_done() by pre-populating and consuming the queue
        uq._get_queue().put_nowait(job)
        _ = await uq._get_queue().get()

        await uq._process_job(job, pool, sem)

        # register_sensor never called because rtsp_publisher.start raised first
        nv_mod.register_sensor.assert_not_awaited()
        # unregister_sensor not called (sensor_uuid is None)
        nv_mod.unregister_sensor.assert_not_awaited()
        # remove_stream still called
        ds_mod.remove_stream.assert_awaited_once_with("vid3")
        # rtsp_publisher.stop still called (no-op when never started)
        pub_mod.stop.assert_called_once_with("vid3")


if __name__ == "__main__":
    unittest.main()
