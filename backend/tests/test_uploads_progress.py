"""Unit tests for GET /api/uploads/:id/progress.

Stubs out `app.db` and `app.main` before importing uploads_list so the
module-level `from app.db import get_pool` doesn't fail outside Docker.
Tests call get_upload_progress() directly, bypassing FastAPI routing.
"""

import asyncio
import os
import sys
import types
import unittest
from unittest.mock import patch


def _stub_app_imports():
    """Insert fake modules into sys.modules so uploads_list loads without Docker."""
    if "app" not in sys.modules:
        app_stub = types.ModuleType("app")
        sys.modules["app"] = app_stub
    if "app.db" not in sys.modules:
        db_stub = types.ModuleType("app.db")
        db_stub.get_pool = lambda: None  # overridden per-test via patch
        sys.modules["app.db"] = db_stub
    if "app.upload_queue" not in sys.modules:
        uq_stub = types.ModuleType("app.upload_queue")
        uq_stub.get_active_job_id = lambda: None
        uq_stub.get_queue_position = lambda video_id: None
        sys.modules["app.upload_queue"] = uq_stub
    if "app.auth" not in sys.modules:
        auth_stub = types.ModuleType("app.auth")
        auth_stub.require_user = lambda: {"user_id": "test-user", "email": "t@example.com"}
        auth_stub.verify_ws_token = lambda token: {"user_id": "test-user"}
        auth_stub.user_short = lambda uid: "deadbeef"
        sys.modules["app.auth"] = auth_stub
    # Stub fastapi if not installed
    if "fastapi" not in sys.modules:
        fastapi_stub = types.ModuleType("fastapi")

        class _HTTPException(Exception):
            def __init__(self, status_code: int, detail: str = ""):
                self.status_code = status_code
                self.detail = detail

        class _APIRouter:
            def get(self, *a, **kw):
                return lambda f: f

            def post(self, *a, **kw):
                return lambda f: f

            def delete(self, *a, **kw):
                return lambda f: f

        fastapi_stub.HTTPException = _HTTPException
        fastapi_stub.APIRouter = _APIRouter
        fastapi_stub.UploadFile = object
        fastapi_stub.Form = lambda **kw: None
        fastapi_stub.Depends = lambda dep=None: None
        sys.modules["fastapi"] = fastapi_stub

        # fastapi.responses stub
        fastapi_responses = types.ModuleType("fastapi.responses")
        fastapi_responses.Response = object
        fastapi_responses.FileResponse = object
        sys.modules["fastapi.responses"] = fastapi_responses


_stub_app_imports()

# Now safe to import the module under test
from backend.app.uploads_list import get_upload_progress  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def _make_row(
    video_id="vid1",
    duration_s=60.0,
    event_count=0,
    incidents_total=0,
    vlm_pending=0,
    vlm_done=0,
    vlm_skipped=0,
    vlm_error=0,
):
    """Return a dict that behaves like an asyncpg Record (subscript access)."""
    return {
        "video_id": video_id,
        "duration_s": duration_s,
        "event_count": event_count,
        "incidents_total": incidents_total,
        "vlm_pending": vlm_pending,
        "vlm_done": vlm_done,
        "vlm_skipped": vlm_skipped,
        "vlm_error": vlm_error,
    }


class FakePool:
    def __init__(self, row):
        self._row = row

    async def fetchrow(self, sql, *args):
        return self._row


def _run(coro):
    return asyncio.run(coro)


class ProgressEndpointTests(unittest.TestCase):

    def _call(self, pool_row, env_vlm="false"):
        pool = FakePool(pool_row)
        user = {"user_id": "test-user", "email": "t@example.com"}
        with patch("backend.app.uploads_list.get_pool", return_value=pool), \
             patch.dict(os.environ, {"VLM_ENABLED": env_vlm}):
            return _run(get_upload_progress("vid1", user))

    # ------------------------------------------------------------------
    # zeros: upload exists, no events, no incidents
    # ------------------------------------------------------------------
    def test_zeros_no_events_no_incidents(self):
        result = self._call(_make_row())
        self.assertEqual(result["video_id"], "vid1")
        self.assertEqual(result["duration_s"], 60.0)
        self.assertEqual(result["event_count"], 0)
        self.assertEqual(result["incidents_total"], 0)
        self.assertEqual(result["vlm_pending"], 0)
        self.assertEqual(result["vlm_done"], 0)
        self.assertEqual(result["vlm_skipped"], 0)
        self.assertEqual(result["vlm_error"], 0)
        self.assertFalse(result["vlm_enabled"])

    # ------------------------------------------------------------------
    # mid-pipeline: events flowing, incidents pending
    # ------------------------------------------------------------------
    def test_mid_pipeline_events_and_pending_incidents(self):
        row = _make_row(event_count=12480, incidents_total=7, vlm_pending=5, vlm_done=2)
        result = self._call(row, env_vlm="true")
        self.assertEqual(result["event_count"], 12480)
        self.assertEqual(result["incidents_total"], 7)
        self.assertEqual(result["vlm_pending"], 5)
        self.assertEqual(result["vlm_done"], 2)
        self.assertEqual(result["vlm_skipped"], 0)
        self.assertEqual(result["vlm_error"], 0)
        self.assertTrue(result["vlm_enabled"])

    # ------------------------------------------------------------------
    # settled: all VLM done
    # ------------------------------------------------------------------
    def test_settled_all_vlm_done(self):
        row = _make_row(event_count=28296, incidents_total=7, vlm_pending=0, vlm_done=7)
        result = self._call(row, env_vlm="true")
        self.assertEqual(result["vlm_pending"], 0)
        self.assertEqual(result["vlm_done"], 7)
        self.assertEqual(result["incidents_total"], 7)

    def test_settled_mixed_skipped_and_error(self):
        row = _make_row(
            event_count=5000,
            incidents_total=10,
            vlm_pending=0,
            vlm_done=6,
            vlm_skipped=3,
            vlm_error=1,
        )
        result = self._call(row)
        self.assertEqual(result["vlm_pending"], 0)
        self.assertEqual(result["vlm_done"], 6)
        self.assertEqual(result["vlm_skipped"], 3)
        self.assertEqual(result["vlm_error"], 1)
        self.assertEqual(result["incidents_total"], 10)

    # ------------------------------------------------------------------
    # 404: upload not found
    # ------------------------------------------------------------------
    def test_404_for_missing_upload(self):
        pool = FakePool(None)  # fetchrow returns None → upload not found (or not owned)
        user = {"user_id": "test-user"}
        with patch("backend.app.uploads_list.get_pool", return_value=pool), \
             patch.dict(os.environ, {"VLM_ENABLED": "false"}):
            with self.assertRaises(HTTPException) as ctx:
                _run(get_upload_progress("missing", user))
        self.assertEqual(ctx.exception.status_code, 404)

    # ------------------------------------------------------------------
    # VLM_ENABLED env var toggling
    # ------------------------------------------------------------------
    def test_vlm_enabled_true_when_env_true(self):
        result = self._call(_make_row(), env_vlm="true")
        self.assertTrue(result["vlm_enabled"])

    def test_vlm_enabled_false_when_env_false(self):
        result = self._call(_make_row(), env_vlm="false")
        self.assertFalse(result["vlm_enabled"])

    def test_vlm_enabled_false_when_env_missing(self):
        env = {k: v for k, v in os.environ.items() if k != "VLM_ENABLED"}
        pool = FakePool(_make_row())
        user = {"user_id": "test-user"}
        with patch("backend.app.uploads_list.get_pool", return_value=pool), \
             patch.dict(os.environ, env, clear=True):
            result = _run(get_upload_progress("vid1", user))
        self.assertFalse(result["vlm_enabled"])

    # ------------------------------------------------------------------
    # queue fields present in response
    # ------------------------------------------------------------------
    def test_progress_includes_queue_fields(self):
        """Both queue_status and queue_position are present; queue_status is a valid value."""
        valid_statuses = {"queued", "active", "done", None}
        result = self._call(_make_row())
        self.assertIn("queue_status", result)
        self.assertIn("queue_position", result)
        self.assertIn(result["queue_status"], valid_statuses)


if __name__ == "__main__":
    unittest.main()
