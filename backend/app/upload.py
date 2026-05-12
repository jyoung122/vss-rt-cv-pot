import os
import re
import asyncio
import json
import logging
import time
import subprocess
from pathlib import Path
from fastapi import APIRouter, Depends, UploadFile, Form, HTTPException
from fastapi.responses import JSONResponse
import httpx

from app.auth import require_user, user_short
from app.logging_config import Timer, log_context, new_run_id
from app.redis_client import clear_stream
from app.db import get_pool
from app.upload_queue import enqueue, get_queue_depth, QueueFull, UPLOAD_QUEUE_MAX_DEPTH

DATA_DIR = os.getenv("DATA_DIR", "/data")
HOST_IP = os.getenv("HOST_IP", "localhost")
NVSTREAMER_URL = os.getenv("NVSTREAMER_URL", "http://nvstreamer:30000")

router = APIRouter()
log = logging.getLogger(__name__)


async def _get_nvstreamer_rtsp_url(filename: str) -> str | None:
    """Query NVStreamer for the RTSP URL of a given filename."""
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(f"{NVSTREAMER_URL}/api/v1/sensor/streams")
            if resp.status_code != 200:
                return None
            for entry in resp.json():
                for stream_list in entry.values():
                    for stream in stream_list:
                        if stream.get("url", "").endswith(f"/{filename}"):
                            return stream["url"]
        except Exception as e:
            log.warning("nvstreamer.streams.query_failed", extra={"error": str(e)})
    return None


def _extract_thumbnail(video_path: Path, video_id: str) -> None:
    """Extract a single JPEG frame from ~5 % into the video for use as a thumbnail."""
    try:
        thumb_dir = Path(DATA_DIR) / "thumbs"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        out = thumb_dir / f"{video_id}.jpg"
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-ss", "0",
                "-i", str(video_path),
                "-vframes", "1",
                "-q:v", "4",
                "-vf", "scale=320:-1",
                str(out),
            ],
            capture_output=True,
            timeout=30,
        )
    except Exception as e:
        log.warning("thumbnail.extract_failed", extra={"error": str(e)})


def _probe_video(path: Path) -> tuple[float | None, int | None, int | None, float | None]:
    """Run ffprobe on the file; return (duration_s, width, height, fps). All may be None."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format", "-show_streams",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None, None, None, None
        info = json.loads(result.stdout)
    except Exception as e:
        log.warning("ffprobe.probe_failed", extra={"error": str(e)})
        return None, None, None, None

    duration_s: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None

    try:
        duration_s = float(info["format"]["duration"])
    except (KeyError, ValueError, TypeError):
        pass

    for stream in info.get("streams", []):
        if stream.get("codec_type") == "video":
            try:
                width = int(stream["width"])
                height = int(stream["height"])
            except (KeyError, ValueError, TypeError):
                pass
            try:
                num, den = stream["avg_frame_rate"].split("/")
                fps = float(num) / float(den)
            except Exception:
                pass
            break

    return duration_s, width, height, fps


@router.post("/api/upload")
async def upload_video(
    file: UploadFile,
    prompt: str | None = Form(default=None),
    user: dict = Depends(require_user),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in [".mp4", ".mkv"]:
        raise HTTPException(status_code=400, detail="Only .mp4 and .mkv files allowed")

    # Check queue depth before writing the file
    depth = get_queue_depth()
    if depth >= UPLOAD_QUEUE_MAX_DEPTH:
        log.warning("upload.queue.full", extra={"depth": depth})
        return JSONResponse(
            status_code=503,
            content={"error": "queue full", "queue_depth": depth},
        )

    video_dir = Path(DATA_DIR) / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)

    # Generate a server-side unique video_id from the stem + owner hash + timestamp.
    # Owner hash makes ids non-trivially-guessable across tenants and gives operators
    # a quick visual ownership cue in logs.
    raw_stem = Path(file.filename).stem
    safe_stem = re.sub(r"[^a-zA-Z0-9_-]", "_", raw_stem)
    user_id = user["user_id"]
    video_id = f"{safe_stem}-{user_short(user_id)}-{int(time.time())}"
    run_id = new_run_id()

    with log_context(run_id=run_id, video_id=video_id):
        timer = Timer()
        log.info(
            "upload.run.start",
            extra={"original_filename": file.filename, "content_type": file.content_type},
        )

        file_path = video_dir / f"{video_id}{ext}"
        written = 0
        with open(file_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                f.write(chunk)
                written += len(chunk)

        if written == 0:
            file_path.unlink(missing_ok=True)
            log.warning("upload.file.empty", extra={"original_filename": file.filename})
            raise HTTPException(status_code=400, detail="File is empty")

        # Probe video metadata
        duration_s, width, height, fps = _probe_video(file_path)
        log.info(
            "upload.metadata.probed",
            extra={
                "duration_s": duration_s,
                "width": width,
                "height": height,
                "fps": fps,
                "size_bytes": written,
            },
        )

        # Insert into Postgres
        pool = get_pool()
        await pool.execute(
            """
            INSERT INTO uploads (video_id, original_filename, prompt, duration_s, width, height, fps, size_bytes, user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            video_id,
            file.filename,
            prompt,
            duration_s,
            width,
            height,
            fps,
            written,
            user_id,
        )

        # Extract thumbnail — best-effort, non-fatal
        await asyncio.get_event_loop().run_in_executor(
            None, _extract_thumbnail, file_path, video_id
        )

        # Enqueue for serial processing (redis-set / url-file / container-restart)
        try:
            queue_info = enqueue(video_id, str(file_path), ext)
        except QueueFull as exc:
            # Rare TOCTOU: another request snuck in — still honour the contract
            log.warning("upload.queue.full.toctou", extra={"depth": exc.depth})
            return JSONResponse(
                status_code=503,
                content={"error": "queue full", "queue_depth": exc.depth},
            )

        # Fetch the row to return canonical UploadRecord
        row = await pool.fetchrow(
            "SELECT * FROM uploads WHERE video_id=$1", video_id
        )
        log.info(
            "upload.run.complete",
            extra={
                "duration_ms": timer.duration_ms,
                "original_filename": file.filename,
                "size_bytes": written,
                "queue_status": queue_info["queue_status"],
                "queue_position": queue_info["queue_position"],
            },
        )

    return JSONResponse(
        status_code=202,
        content={
            "video_id": row["video_id"],
            "original_filename": row["original_filename"],
            "prompt": row["prompt"],
            "duration_s": row["duration_s"],
            "width": row["width"],
            "height": row["height"],
            "fps": row["fps"],
            "size_bytes": row["size_bytes"],
            "uploaded_at": row["uploaded_at"].isoformat(),
            "playback_url": f"/api/video/{video_id}",
            "event_count": 0,
            "track_count": 0,
            "queue_status": queue_info["queue_status"],
            "queue_position": queue_info["queue_position"],
        },
    )
