import os
import logging
import urllib.parse
import httpx

NVSTREAMER_URL = os.getenv("NVSTREAMER_URL", "http://nvstreamer:30000")
log = logging.getLogger(__name__)


async def register_sensor(name: str, rtsp_url: str) -> str:
    """POST /api/v1/sensor/add — returns the sensor_uuid assigned by NVStreamer.

    Note: ``tags`` must be a string, not an array — NVStreamer raises
    ``Json::LogicError`` if an array is supplied (validated 2026-05-12).
    """
    payload = {
        "name": name,
        "sensorUrl": rtsp_url,
        "location": "",
        "tags": "",
        "username": "",
        "password": "",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(f"{NVSTREAMER_URL}/api/v1/sensor/add", json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data["sensorId"]


async def unregister_sensor(sensor_uuid: str) -> None:
    """DELETE /api/v1/sensor/<sensor_uuid>.  Logs a warning on non-2xx; never raises."""
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.delete(f"{NVSTREAMER_URL}/api/v1/sensor/{sensor_uuid}")
            if resp.status_code not in (200, 204):
                log.warning(
                    "nvstreamer.sensor.unregister.degraded",
                    extra={"sensor_uuid": sensor_uuid, "status_code": resp.status_code},
                )
        except Exception as e:
            log.warning(
                "nvstreamer.sensor.unregister.failed",
                extra={"sensor_uuid": sensor_uuid, "error": str(e)},
            )


async def get_proxy_url(sensor_uuid: str) -> str | None:
    """GET /api/v1/sensor/list — returns the NVStreamer RTSP proxy URL for the sensor.

    Returns ``None`` if the sensor is not found or the list endpoint is unreachable.
    """
    sensors = await list_sensors()
    for entry in sensors:
        if entry.get("sensorId") == sensor_uuid:
            return f"rtsp://{_nvstreamer_host()}:30554/live/{sensor_uuid}"
    return None


async def list_sensors() -> list[dict]:
    """GET /api/v1/sensor/list — raw sensor list; useful for ops/debugging."""
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(f"{NVSTREAMER_URL}/api/v1/sensor/list")
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            log.warning("nvstreamer.sensor.list.failed", extra={"error": str(e)})
    return []


def _nvstreamer_host() -> str:
    """Extract the hostname portion of NVSTREAMER_URL for RTSP proxy URL construction."""
    parsed = urllib.parse.urlparse(NVSTREAMER_URL)
    return parsed.hostname or "nvstreamer"
