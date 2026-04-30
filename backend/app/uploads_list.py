"""List + delete API for previously uploaded clips.

POT does not maintain an upload history database; this endpoint reads the
shared video directory directly. Good enough for v1 demo.
"""

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

DATA_DIR = os.getenv("DATA_DIR", "/data")

router = APIRouter()

ALLOWED_SUFFIXES = {".mp4", ".mkv"}


@router.get("/api/uploads")
async def list_uploads():
    video_dir = Path(DATA_DIR) / "videos"
    if not video_dir.exists():
        return {"uploads": []}

    items = []
    for path in video_dir.iterdir():
        if not path.is_file():
            continue
        if path.suffix.lower() not in ALLOWED_SUFFIXES:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        video_id = path.stem
        items.append(
            {
                "video_id": video_id,
                "filename": path.name,
                "size_bytes": stat.st_size,
                "uploaded_at": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
                "playback_url": f"/api/video/{video_id}",
            }
        )

    items.sort(key=lambda i: i["uploaded_at"], reverse=True)
    return {"uploads": items}


@router.delete("/api/uploads/{video_id}")
async def delete_upload(video_id: str):
    video_dir = Path(DATA_DIR) / "videos"
    found = False
    for suffix in ALLOWED_SUFFIXES:
        candidate = video_dir / f"{video_id}{suffix}"
        if candidate.exists():
            candidate.unlink()
            found = True
    if not found:
        raise HTTPException(status_code=404, detail="Upload not found")
    return {"status": "deleted", "video_id": video_id}
