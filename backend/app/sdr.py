import os
import httpx

# SDR API body shape is undocumented — verify against docker logs sdr-streamprocessing during a live NVStreamer upload

SDR_URL = os.getenv("SDR_URL", "http://sdr:4001")


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
            print(f"Error removing active stream: {e}")


async def register_stream(video_id: str, rtsp_url: str) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            payload = {"id": video_id, "url": rtsp_url, "type": "rtsp"}
            resp = await client.post(f"{SDR_URL}/api/v1/stream/add", json=payload)
            if resp.status_code not in [200, 201]:
                print(f"SDR stream registration failed: {resp.status_code} {resp.text}")
        except Exception as e:
            print(f"Error registering stream with SDR: {e}")
