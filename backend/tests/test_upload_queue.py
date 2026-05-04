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
    # Replace with a fresh queue bound to the current event loop
    import asyncio as _asyncio
    try:
        loop = _asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    uq._queue = _asyncio.Queue()
    uq._active_job_id = None


class _FakePool:
    """asyncpg-like pool stub."""

    def __init__(self, event_count: int = 0, duration_s: float = 5.0):
        self._event_count = event_count
        self._duration_s = duration_s
        self._fetchrow_row = {"duration_s": duration_s}

    async def fetchrow(self, sql, *args):
        return self._fetchrow_row

    async def fetchval(self, sql, *args):
        return self._event_count


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class EnqueueTests(unittest.TestCase):

    def setUp(self):
        _reset_queue()

    def tearDown(self):
        _reset_queue()

    def test_enqueue_empty_returns_active(self):
        """First job into an empty queue gets queue_status='active', queue_position=0."""
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
        # Temporarily set max depth to 2
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


class WorkerTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        _reset_queue()

    def tearDown(self):
        _reset_queue()

    async def test_worker_processes_serially(self):
        """Submit 2 jobs; verify they execute in order and second starts after first completes."""
        processed = []
        first_done = asyncio.Event()

        async def fake_process_job(job, pool):
            processed.append(("start", job["video_id"]))
            if job["video_id"] == "vid1":
                await asyncio.sleep(0.05)
            processed.append(("done", job["video_id"]))
            if job["video_id"] == "vid1":
                first_done.set()

        pool = _FakePool()
        uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        uq.enqueue("vid2", "/data/videos/vid2.mp4", ".mp4")

        with patch.object(uq, "_process_job", side_effect=fake_process_job):
            task = asyncio.create_task(uq._worker_loop(pool))
            # Give the worker time to process both jobs
            await asyncio.sleep(0.3)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # Both jobs must have run
        self.assertIn(("start", "vid1"), processed)
        self.assertIn(("done", "vid1"), processed)
        self.assertIn(("start", "vid2"), processed)
        self.assertIn(("done", "vid2"), processed)

        # vid1 must finish before vid2 starts
        idx_vid1_done = processed.index(("done", "vid1"))
        idx_vid2_start = processed.index(("start", "vid2"))
        self.assertLess(idx_vid1_done, idx_vid2_start)

    async def test_worker_swallows_exceptions(self):
        """First job raises; worker logs and advances; second job still runs."""
        processed = []

        async def fake_process_job(job, pool):
            if job["video_id"] == "vid1":
                raise RuntimeError("simulated failure")
            processed.append(job["video_id"])

        pool = _FakePool()
        uq.enqueue("vid1", "/data/videos/vid1.mp4", ".mp4")
        uq.enqueue("vid2", "/data/videos/vid2.mp4", ".mp4")

        with patch.object(uq, "_process_job", side_effect=fake_process_job):
            task = asyncio.create_task(uq._worker_loop(pool))
            await asyncio.sleep(0.2)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # vid2 must have run despite vid1 raising
        self.assertIn("vid2", processed)


if __name__ == "__main__":
    unittest.main()
