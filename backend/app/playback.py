import asyncio
import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.auth import require_user
from app.db import get_pool

DATA_DIR = os.getenv("DATA_DIR", "/data")
MAX_CLIP_DURATION_S = 120.0

router = APIRouter()
log = logging.getLogger(__name__)


def _resolve_source(video_id: str, original_filename: str) -> Path:
    ext = Path(original_filename).suffix.lower()
    return Path(DATA_DIR) / "videos" / f"{video_id}{ext}"


@router.get("/api/video/{video_id}")
async def get_video(video_id: str, user: dict = Depends(require_user)):
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT original_filename FROM uploads WHERE video_id=$1 AND user_id=$2",
        video_id, user["user_id"],
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Video not found")

    video_path = _resolve_source(video_id, row["original_filename"])
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found on disk")

    ext = video_path.suffix.lower()
    media_type = "video/x-matroska" if ext == ".mkv" else "video/mp4"
    return FileResponse(path=video_path, media_type=media_type)


@router.get("/api/uploads/{video_id}/clip")
async def get_clip(
    video_id: str,
    start: float = Query(..., ge=0.0),
    end: float = Query(..., gt=0.0),
    label: str = Query("clip"),
    user: dict = Depends(require_user),
):
    """Trim the source video to [start, end] seconds and return as MP4.

    Re-encodes with libx264 for precise cuts (stream-copy would snap to
    keyframes, which on 15fps surveillance footage can be many seconds off).
    """
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be greater than start")
    duration = end - start
    if duration > MAX_CLIP_DURATION_S:
        raise HTTPException(
            status_code=400,
            detail=f"clip duration {duration:.1f}s exceeds {MAX_CLIP_DURATION_S:.0f}s limit",
        )

    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT original_filename FROM uploads WHERE video_id=$1 AND user_id=$2",
        video_id, user["user_id"],
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Video not found")

    src = _resolve_source(video_id, row["original_filename"])
    if not src.exists():
        raise HTTPException(status_code=404, detail="Video file not found on disk")

    fd, tmp_path = tempfile.mkstemp(prefix=f"clip_{video_id}_", suffix=".mp4")
    os.close(fd)
    out = Path(tmp_path)

    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", str(src),
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-an",
        "-movflags", "+faststart",
        str(out),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        log.warning(
            "clip.ffmpeg.fail",
            extra={"video_id": video_id, "rc": proc.returncode,
                   "stderr_tail": stderr.decode(errors="replace")[-400:]},
        )
        raise HTTPException(status_code=500, detail="Failed to extract clip")

    safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)[:40] or "clip"
    base = Path(row["original_filename"]).stem
    download_name = f"{base}_{safe_label}_{start:.1f}-{end:.1f}.mp4"

    return FileResponse(
        path=out,
        media_type="video/mp4",
        filename=download_name,
        background=BackgroundTask(out.unlink, missing_ok=True),
    )
