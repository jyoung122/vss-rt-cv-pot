"""Unit tests for backend/app/deepstream.py.

All HTTP calls are mocked — no real DeepStream container needed.
"""

import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Stub out httpx before importing the module under test
# ---------------------------------------------------------------------------

def _stub_imports():
    if "httpx" not in sys.modules:
        httpx_mod = types.ModuleType("httpx")
        # Provide a placeholder AsyncClient so patch() can find the attribute.
        httpx_mod.AsyncClient = MagicMock
        sys.modules["httpx"] = httpx_mod
    elif not hasattr(sys.modules["httpx"], "AsyncClient"):
        sys.modules["httpx"].AsyncClient = MagicMock


_stub_imports()

import backend.app.deepstream as ds  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_response(status_code: int, json_data=None):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_data or {})
    resp.raise_for_status = MagicMock()
    return resp


class _MockAsyncClient:
    """Async context-manager that returns a configurable mock client."""

    def __init__(self, **method_returns):
        self._client = MagicMock()
        for method, rv in method_returns.items():
            setattr(self._client, method, AsyncMock(return_value=rv))

    async def __aenter__(self):
        return self._client

    async def __aexit__(self, *_):
        pass


# ---------------------------------------------------------------------------
# add_stream
# ---------------------------------------------------------------------------

class TestAddStream(unittest.TestCase):

    def test_posts_correct_payload(self):
        resp = _make_response(200, {})
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            _run(ds.add_stream("vid1", "rtsp://mediamtx:8554/vid1"))
        call_kwargs = mock_ctx._client.post.call_args
        url = call_kwargs.args[0]
        payload = call_kwargs.kwargs["json"]
        self.assertIn("/api/v1/stream/add", url)
        self.assertEqual(payload["key"], "stream")
        self.assertEqual(payload["value"]["camera_id"], "vid1")
        self.assertEqual(payload["value"]["camera_url"], "rtsp://mediamtx:8554/vid1")
        self.assertEqual(payload["value"]["change"], "add")

    def test_raises_on_http_error(self):
        resp = _make_response(500)
        resp.raise_for_status.side_effect = Exception("500 Server Error")
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertRaises(Exception):
                _run(ds.add_stream("vid1", "rtsp://mediamtx:8554/vid1"))

    def test_raises_on_network_error(self):
        mock_ctx = _MockAsyncClient()
        mock_ctx._client.post = AsyncMock(side_effect=Exception("connection refused"))
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertRaises(Exception):
                _run(ds.add_stream("vid1", "rtsp://mediamtx:8554/vid1"))


# ---------------------------------------------------------------------------
# remove_stream
# ---------------------------------------------------------------------------

class TestRemoveStream(unittest.TestCase):

    def test_success_200_does_not_raise(self):
        resp = _make_response(200, {})
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            _run(ds.remove_stream("vid1"))  # should not raise

    def test_success_204_does_not_raise(self):
        resp = _make_response(204, {})
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            _run(ds.remove_stream("vid1"))

    def test_posts_correct_payload(self):
        resp = _make_response(200, {})
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            _run(ds.remove_stream("vid1"))
        call_kwargs = mock_ctx._client.post.call_args
        url = call_kwargs.args[0]
        payload = call_kwargs.kwargs["json"]
        self.assertIn("/api/v1/stream/remove", url)
        self.assertEqual(payload["key"], "stream")
        self.assertEqual(payload["value"]["camera_id"], "vid1")
        self.assertEqual(payload["value"]["change"], "remove")

    def test_non_2xx_logs_warning_does_not_raise(self):
        resp = _make_response(404, {})
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertLogs("backend.app.deepstream", level="WARNING"):
                _run(ds.remove_stream("vid-missing"))  # must not raise

    def test_network_error_logs_warning_does_not_raise(self):
        mock_ctx = _MockAsyncClient()
        mock_ctx._client.post = AsyncMock(side_effect=Exception("timeout"))
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertLogs("backend.app.deepstream", level="WARNING"):
                _run(ds.remove_stream("vid1"))  # must not raise


# ---------------------------------------------------------------------------
# get_stream_info
# ---------------------------------------------------------------------------

class TestGetStreamInfo(unittest.TestCase):

    def test_returns_dict_on_200(self):
        body = {"camera_id": "vid1", "status": "running"}
        resp = _make_response(200, body)
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            result = _run(ds.get_stream_info("vid1"))
        self.assertEqual(result, body)

    def test_returns_none_on_non_200(self):
        resp = _make_response(404, {})
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertLogs("backend.app.deepstream", level="WARNING"):
                result = _run(ds.get_stream_info("vid1"))
        self.assertIsNone(result)

    def test_returns_none_on_network_error(self):
        mock_ctx = _MockAsyncClient()
        mock_ctx._client.get = AsyncMock(side_effect=Exception("timeout"))
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertLogs("backend.app.deepstream", level="WARNING"):
                result = _run(ds.get_stream_info("vid1"))
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# is_ready
# ---------------------------------------------------------------------------

class TestIsReady(unittest.TestCase):

    def _run_with_body(self, body: dict) -> bool:
        resp = _make_response(200, body)
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            return _run(ds.is_ready())

    def test_ds_ready_status(self):
        self.assertTrue(self._run_with_body({"status": "DS_READY"}))

    def test_ready_status(self):
        self.assertTrue(self._run_with_body({"status": "READY"}))

    def test_ok_status(self):
        self.assertTrue(self._run_with_body({"status": "OK"}))

    def test_not_ready_status(self):
        self.assertFalse(self._run_with_body({"status": "INITIALIZING"}))

    def test_non_200_returns_false(self):
        resp = _make_response(503, {})
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            result = _run(ds.is_ready())
        self.assertFalse(result)

    def test_network_error_returns_false(self):
        mock_ctx = _MockAsyncClient()
        mock_ctx._client.get = AsyncMock(side_effect=Exception("connection refused"))
        with patch("backend.app.deepstream.httpx.AsyncClient", return_value=mock_ctx):
            result = _run(ds.is_ready())
        self.assertFalse(result)


if __name__ == "__main__":
    unittest.main()
