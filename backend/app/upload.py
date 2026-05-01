import os
import re
import asyncio
import json
import logging
import time
import subprocess
from pathlib import Path
from fastapi import APIRouter, UploadFile, Form, HTTPException
import httpx

from app.logging_config import Timer, log_context, new_run_id
from app.sdr import remove_active_stream, register_stream
from app.redis_client import clear_stream
from app.db import get_pool

DATA_DIR = os.getenv("DATA_DIR", "/data")
HOST_IP = os.getenv("HOST_IP", "localhost")
NVSTREAMER_URL = os.getenv("NVSTREAMER_URL", "http://nvstreamer:30000")
DOCKER_SOCK = "/var/run/docker.sock"
REDIS_URL = f"redis://{os.getenv('REDIS_HOST', 'redis')}:{os.getenv('REDIS_PORT', '6379')}"

router = APIRouter()
log = logging.getLogger(__name__)


async def _docker_api(method: str, path: str, body: dict | None = None) -> int:
    """Call Docker Engine API via unix socket. Returns HTTP status code."""
    cmd = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", method,
           "--unix-socket", DOCKER_SOCK, f"http://localhost{path}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    try:
        return int(stdout.decode().strip())
    except ValueError:
        return 0


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


async def _restart_container(name: str) -> None:
    status = await _docker_api("POST", f"/containers/{name}/restart?t=5")
    if status not in (204, 304):
        log.warning("docker.container.restart.degraded", extra={"container": name, "status_code": status})


async def _update_vss_rt_cv_stream(rtsp_url: str) -> None:
    """Restart vss-rt-cv with the new STREAM_URI so DeepStream picks it up."""
    # Update the container's env var by stopping, updating, and starting
    # Simpler approach: just restart — ds-start.sh reads STREAM_URI env var
    # We need to update the env var first via Docker API
    # Get current container config
    cmd = ["curl", "-s", "--unix-socket", DOCKER_SOCK,
           "http://localhost/containers/vss-rt-cv/json"]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    try:
        config = json.loads(stdout.decode())
        env = config.get("Config", {}).get("Env", [])
        new_env = [e for e in env if not e.startswith("STREAM_URI=")]
        new_env.append(f"STREAM_URI={rtsp_url}")
    except Exception as e:
        log.warning("docker.container.config.read_failed", extra={"container": "vss-rt-cv", "error": str(e)})
        return

    # Docker doesn't support updating env vars on a running container.
    # Write the RTSP URL to a shared file that ds-start.sh can read instead.
    url_file = Path(DATA_DIR) / "videos" / "current_stream_url.txt"
    url_file.write_text(rtsp_url)

    await _restart_container("vss-rt-cv")


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
async def upload_video(file: UploadFile, prompt: str | None = Form(default=None)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in [".mp4", ".mkv"]:
        raise HTTPException(status_code=400, detail="Only .mp4 and .mkv files allowed")

    video_dir = Path(DATA_DIR) / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)

    # Generate a server-side unique video_id from the stem + timestamp
    raw_stem = Path(file.filename).stem
    safe_stem = re.sub(r"[^a-zA-Z0-9_-]", "_", raw_stem)
    video_id = f"{safe_stem}-{int(time.time())}"
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
            INSERT INTO uploads (video_id, original_filename, prompt, duration_s, width, height, fps, size_bytes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            video_id,
            file.filename,
            prompt,
            duration_s,
            width,
            height,
            fps,
            written,
        )

        # Set current_video_id in Redis for the event indexer
        import redis.asyncio as aioredis
        r = aioredis.from_url(REDIS_URL, decode_responses=True)
        async with r:
            await r.set("current_video_id", video_id)
        log.info("upload.current_video.set")

        stream_url = f"file:///data/videos/{video_id}{ext}"

        # Write stream URL for ds-start.sh
        url_file = Path(DATA_DIR) / "videos" / "current_stream_url.txt"
        url_file.write_text(stream_url)

        await remove_active_stream()
        await register_stream(video_id, stream_url)
        await _update_vss_rt_cv_stream(stream_url)

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
            },
        )

    return {
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
    }
