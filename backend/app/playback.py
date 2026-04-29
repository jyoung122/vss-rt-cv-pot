import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

DATA_DIR = os.getenv("DATA_DIR", "/data")

router = APIRouter()


@router.get("/api/video/{video_id}")
async def get_video(video_id: str):
    video_dir = Path(DATA_DIR) / "videos"

    # Try to find the file (it could be .mp4 or .mkv)
    video_path = None
    for ext in [".mp4", ".mkv"]:
        candidate = video_dir / f"{video_id}{ext}"
        if candidate.exists():
            video_path = candidate
            break

    if not video_path:
        raise HTTPException(status_code=404, detail="Video not found")

    return FileResponse(path=video_path, media_type="video/mp4")
