"""Unit tests for backend/app/nvstreamer.py.

All HTTP calls are mocked — no real NVStreamer needed.
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
        sys.modules["httpx"] = httpx_mod


_stub_imports()

import backend.app.nvstreamer as nv  # noqa: E402


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
# register_sensor
# ---------------------------------------------------------------------------

class TestRegisterSensor(unittest.TestCase):
    def test_returns_sensor_id_on_success(self):
        resp = _make_response(201, {"sensorId": "uuid-abc"})
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            sensor_id = _run(nv.register_sensor("cam01", "rtsp://mediamtx:8554/cam01"))
        self.assertEqual(sensor_id, "uuid-abc")

    def test_raises_on_http_error(self):
        resp = _make_response(500)
        resp.raise_for_status.side_effect = Exception("500 Server Error")
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertRaises(Exception):
                _run(nv.register_sensor("cam01", "rtsp://mediamtx:8554/cam01"))

    def test_payload_contains_string_tags(self):
        """tags must be a string, not an array (NVStreamer Json::LogicError guard)."""
        resp = _make_response(200, {"sensorId": "uuid-xyz"})
        mock_ctx = _MockAsyncClient(post=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            _run(nv.register_sensor("cam02", "rtsp://mediamtx:8554/cam02"))
        call_kwargs = mock_ctx._client.post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs.args[1]
        self.assertIsInstance(payload["tags"], str)


# ---------------------------------------------------------------------------
# unregister_sensor
# ---------------------------------------------------------------------------

class TestUnregisterSensor(unittest.TestCase):
    def test_success_204(self):
        resp = _make_response(204)
        mock_ctx = _MockAsyncClient(delete=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            _run(nv.unregister_sensor("uuid-abc"))  # should not raise

    def test_non_2xx_logs_warning_does_not_raise(self):
        resp = _make_response(404)
        mock_ctx = _MockAsyncClient(delete=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertLogs("backend.app.nvstreamer", level="WARNING"):
                _run(nv.unregister_sensor("uuid-missing"))

    def test_network_error_logs_warning_does_not_raise(self):
        mock_ctx = _MockAsyncClient()
        mock_ctx._client.delete = AsyncMock(side_effect=Exception("connection refused"))
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertLogs("backend.app.nvstreamer", level="WARNING"):
                _run(nv.unregister_sensor("uuid-abc"))


# ---------------------------------------------------------------------------
# list_sensors
# ---------------------------------------------------------------------------

class TestListSensors(unittest.TestCase):
    def test_returns_list_on_200(self):
        sensor_list = [{"sensorId": "a"}, {"sensorId": "b"}]
        resp = _make_response(200, sensor_list)
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            result = _run(nv.list_sensors())
        self.assertEqual(result, sensor_list)

    def test_returns_empty_on_non_200(self):
        resp = _make_response(503, {})
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            result = _run(nv.list_sensors())
        self.assertEqual(result, [])

    def test_returns_empty_on_network_error(self):
        mock_ctx = _MockAsyncClient()
        mock_ctx._client.get = AsyncMock(side_effect=Exception("timeout"))
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            with self.assertLogs("backend.app.nvstreamer", level="WARNING"):
                result = _run(nv.list_sensors())
        self.assertEqual(result, [])


# ---------------------------------------------------------------------------
# get_proxy_url
# ---------------------------------------------------------------------------

class TestGetProxyUrl(unittest.TestCase):
    def test_returns_rtsp_url_when_found(self):
        sensor_list = [{"sensorId": "uuid-abc"}, {"sensorId": "uuid-xyz"}]
        resp = _make_response(200, sensor_list)
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            url = _run(nv.get_proxy_url("uuid-abc"))
        self.assertIn("uuid-abc", url)
        self.assertTrue(url.startswith("rtsp://"))

    def test_returns_none_when_not_found(self):
        resp = _make_response(200, [{"sensorId": "other"}])
        mock_ctx = _MockAsyncClient(get=resp)
        with patch("backend.app.nvstreamer.httpx.AsyncClient", return_value=mock_ctx):
            url = _run(nv.get_proxy_url("uuid-missing"))
        self.assertIsNone(url)


# ---------------------------------------------------------------------------
# _nvstreamer_host
# ---------------------------------------------------------------------------

class TestNvstreamerHost(unittest.TestCase):
    def test_extracts_hostname(self):
        with patch.object(nv, "NVSTREAMER_URL", "http://my-nvstreamer:30000"):
            self.assertEqual(nv._nvstreamer_host(), "my-nvstreamer")

    def test_fallback_when_no_hostname(self):
        with patch.object(nv, "NVSTREAMER_URL", "not-a-url"):
            self.assertEqual(nv._nvstreamer_host(), "nvstreamer")


if __name__ == "__main__":
    unittest.main()
