"""DeepStream nvds_rest_server client.

Talks to the REST API exposed by libnvds_rest_server.so on the vss-rt-cv
container (port 9000 by default).  Used by upload_queue to add and remove
RTSP sources from the live nvmultiurisrcbin pipeline without restarting the
container.

API reference (nvds_rest_server, DeepStream 9.x):
  POST /api/v1/stream/add    — add a source to nvmultiurisrcbin
  POST /api/v1/stream/remove — remove a source by camera_id
  GET  /api/v1/stream/get-stream-info?camera_id=<id> — diagnostics
  GET  /api/v1/health/get-dsready-state — readiness probe
"""

import logging
import os

import httpx

DS_REST_URL = os.getenv("DS_REST_URL", "http://vss-rt-cv:9000")
log = logging.getLogger(__name__)


async def add_stream(video_id: str, rtsp_url: str) -> None:
    """POST /api/v1/stream/add — add a source to nvmultiurisrcbin.

    ``video_id`` is used as both camera_id and camera_name so events can be
    correlated back to the upload record.  Raises on non-2xx (caller must
    handle).
    """
    payload = {
        "key": "stream",
        "value": {
            "camera_id": video_id,
            "camera_name": video_id,
            "camera_url": rtsp_url,
            "change": "add",
        },
        "headers": {"source": "aims-backend"},
    }
    log.info(
        "deepstream.stream.add",
        extra={"video_id": video_id, "rtsp_url": rtsp_url},
    )
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(f"{DS_REST_URL}/api/v1/stream/add", json=payload)
        resp.raise_for_status()
        log.info(
            "deepstream.stream.add.ok",
            extra={"video_id": video_id, "status_code": resp.status_code},
        )


async def remove_stream(video_id: str) -> None:
    """POST /api/v1/stream/remove — remove a source by camera_id.

    Logs a warning on non-2xx but never raises, so teardown always completes.
    """
    payload = {
        "key": "stream",
        "value": {
            "camera_id": video_id,
            "change": "remove",
        },
        "headers": {"source": "aims-backend"},
    }
    log.info("deepstream.stream.remove", extra={"video_id": video_id})
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.post(
                f"{DS_REST_URL}/api/v1/stream/remove", json=payload
            )
            if resp.status_code not in (200, 204):
                log.warning(
                    "deepstream.stream.remove.degraded",
                    extra={
                        "video_id": video_id,
                        "status_code": resp.status_code,
                    },
                )
            else:
                log.info(
                    "deepstream.stream.remove.ok",
                    extra={"video_id": video_id, "status_code": resp.status_code},
                )
        except Exception as exc:
            log.warning(
                "deepstream.stream.remove.failed",
                extra={"video_id": video_id, "error": str(exc)},
            )


async def get_stream_info(video_id: str) -> dict | None:
    """GET /api/v1/stream/get-stream-info?camera_id=<id> — diagnostics only.

    Returns the parsed JSON body, or None if the request fails or the stream
    is not found.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(
                f"{DS_REST_URL}/api/v1/stream/get-stream-info",
                params={"camera_id": video_id},
            )
            if resp.status_code == 200:
                return resp.json()
            log.warning(
                "deepstream.stream.info.not_found",
                extra={"video_id": video_id, "status_code": resp.status_code},
            )
        except Exception as exc:
            log.warning(
                "deepstream.stream.info.failed",
                extra={"video_id": video_id, "error": str(exc)},
            )
    return None


async def is_ready() -> bool:
    """GET /api/v1/health/get-dsready-state — returns True when DS is ready.

    Used by upload_queue to gate job processing until the pipeline is running.
    Returns False on any error (caller should retry).
    """
    async with httpx.AsyncClient(timeout=5) as client:
        try:
            resp = await client.get(
                f"{DS_REST_URL}/api/v1/health/get-dsready-state"
            )
            if resp.status_code == 200:
                body = resp.json()
                # The REST server returns {"status": "DS_READY"} or similar
                ready = body.get("status", "").upper() in ("DS_READY", "READY", "OK")
                log.debug(
                    "deepstream.health",
                    extra={"ready": ready, "body": body},
                )
                return ready
        except Exception as exc:
            log.debug(
                "deepstream.health.unreachable",
                extra={"error": str(exc)},
            )
    return False
