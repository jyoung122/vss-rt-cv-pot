import os
import asyncio
from pathlib import Path
from fastapi import APIRouter, UploadFile, HTTPException
import httpx

from app.sdr import remove_active_stream, register_stream

DATA_DIR = os.getenv("DATA_DIR", "/data")
HOST_IP = os.getenv("HOST_IP", "localhost")
NVSTREAMER_URL = os.getenv("NVSTREAMER_URL", "http://nvstreamer:31000")

router = APIRouter()


@router.post("/api/upload")
async def upload_video(file: UploadFile):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in [".mp4", ".mkv"]:
        raise HTTPException(status_code=400, detail="Only .mp4 and .mkv files allowed")

    video_dir = Path(DATA_DIR) / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)

    file_path = video_dir / file.filename
    content = await file.read()

    if not content:
        raise HTTPException(status_code=400, detail="File is empty")

    with open(file_path, "wb") as f:
        f.write(content)

    video_id = Path(file.filename).stem
    rtsp_url = f"rtsp://{HOST_IP}:31554/{file.filename}"
    playback_url = f"http://{HOST_IP}:8080/api/video/{video_id}"

    # Remove any active stream before registering new one
    await remove_active_stream()

    # Poll NVStreamer stream list until new stream appears
    max_retries = 10
    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{NVSTREAMER_URL}/api/v1/streams")
                if resp.status_code == 200:
                    streams = resp.json().get("streams", [])
                    stream_ids = [s.get("id") for s in streams]
                    if file.filename in stream_ids:
                        break
        except Exception as e:
            print(f"Stream list poll attempt {attempt + 1} failed: {e}")

        if attempt < max_retries - 1:
            await asyncio.sleep(1)

    # Register with SDR
    await register_stream(video_id, rtsp_url)

    return {
        "video_id": video_id,
        "rtsp_url": rtsp_url,
        "playback_url": playback_url,
    }
