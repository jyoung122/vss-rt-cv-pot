import os
import re
import asyncio
import json
from pathlib import Path
from fastapi import APIRouter, UploadFile, HTTPException
import httpx

from app.sdr import remove_active_stream, register_stream

DATA_DIR = os.getenv("DATA_DIR", "/data")
HOST_IP = os.getenv("HOST_IP", "localhost")
NVSTREAMER_URL = os.getenv("NVSTREAMER_URL", "http://nvstreamer:30000")
DOCKER_SOCK = "/var/run/docker.sock"

router = APIRouter()


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
            print(f"Error querying NVStreamer streams: {e}")
    return None


async def _restart_container(name: str) -> None:
    status = await _docker_api("POST", f"/containers/{name}/restart?t=5")
    if status not in (204, 304):
        print(f"Warning: restart {name} returned HTTP {status}")


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
        print(f"Error reading vss-rt-cv config: {e}")
        return

    # Docker doesn't support updating env vars on a running container.
    # Write the RTSP URL to a shared file that ds-start.sh can read instead.
    url_file = Path(DATA_DIR) / "videos" / "current_stream_url.txt"
    url_file.write_text(rtsp_url)

    await _restart_container("vss-rt-cv")


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
    written = 0
    with open(file_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)
            written += len(chunk)

    if written == 0:
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="File is empty")

    video_id = Path(file.filename).stem

    await remove_active_stream()

    await _restart_container("vss-nvstreamer")

    rtsp_url = None
    for attempt in range(15):
        await asyncio.sleep(2)
        rtsp_url = await _get_nvstreamer_rtsp_url(file.filename)
        if rtsp_url:
            break
        print(f"Waiting for NVStreamer to register {file.filename} (attempt {attempt + 1})")

    if not rtsp_url:
        raise HTTPException(
            status_code=503,
            detail="NVStreamer did not register the stream in time",
        )

    # Internal URL uses container IP — rewrite for Docker-network access
    docker_rtsp_url = re.sub(r"rtsp://[^:]+:", "rtsp://nvstreamer:", rtsp_url)
    external_rtsp_url = re.sub(r"rtsp://[^:]+:", f"rtsp://{HOST_IP}:", rtsp_url)

    await register_stream(video_id, docker_rtsp_url)
    await _update_vss_rt_cv_stream(docker_rtsp_url)

    return {
        "video_id": video_id,
        "rtsp_url": external_rtsp_url,
        "internal_rtsp_url": docker_rtsp_url,
    }
