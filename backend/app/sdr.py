import os
import logging
import httpx

# SDR API body shape is undocumented — verify against docker logs sdr-streamprocessing during a live NVStreamer upload

SDR_URL = os.getenv("SDR_URL", "http://sdr:4001")
log = logging.getLogger(__name__)


async def remove_active_stream() -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(f"{SDR_URL}/api/v1/streams")
            if resp.status_code == 200:
                streams = resp.json().get("streams", [])
                for stream in streams:
                    stream_id = stream.get("id")
                    if stream_id:
                        await client.delete(f"{SDR_URL}/api/v1/stream/{stream_id}")
        except Exception as e:
            log.warning("sdr.stream.remove_active.degraded", extra={"error": str(e)})


async def register_stream(video_id: str, rtsp_url: str) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            payload = {"id": video_id, "url": rtsp_url, "type": "rtsp"}
            resp = await client.post(f"{SDR_URL}/api/v1/stream/add", json=payload)
            if resp.status_code not in [200, 201]:
                log.warning(
                    "sdr.stream.register.degraded",
                    extra={"video_id": video_id, "status_code": resp.status_code, "response_text": resp.text[:500]},
                )
        except Exception as e:
            log.warning("sdr.stream.register.failed", extra={"video_id": video_id, "error": str(e)})
