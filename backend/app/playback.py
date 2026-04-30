import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.db import get_pool

DATA_DIR = os.getenv("DATA_DIR", "/data")

router = APIRouter()


@router.get("/api/video/{video_id}")
async def get_video(video_id: str):
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT original_filename FROM uploads WHERE video_id=$1", video_id
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Video not found")

    ext = Path(row["original_filename"]).suffix.lower()
    video_path = Path(DATA_DIR) / "videos" / f"{video_id}{ext}"

    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found on disk")

    media_type = "video/x-matroska" if ext == ".mkv" else "video/mp4"
    return FileResponse(path=video_path, media_type=media_type)
