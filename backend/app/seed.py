"""
Seed sample videos into /data/videos and the uploads table.
Runs at container startup before uvicorn. Idempotent — skips files already in the DB.
"""
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

import asyncpg

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://aims:aims@postgres:5432/aims")
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
SEED_DIR = Path("/app/seed-videos")

log = logging.getLogger("seed")
logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")


def probe(path: Path) -> tuple[float | None, int | None, int | None, float | None]:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None, None, None, None
        info = json.loads(result.stdout)
    except Exception:
        return None, None, None, None

    duration_s = width = height = fps = None
    try:
        duration_s = float(info["format"]["duration"])
    except (KeyError, ValueError, TypeError):
        pass
    for stream in info.get("streams", []):
        if stream.get("codec_type") == "video":
            try:
                width, height = int(stream["width"]), int(stream["height"])
            except (KeyError, ValueError, TypeError):
                pass
            try:
                num, den = stream["avg_frame_rate"].split("/")
                fps = float(num) / float(den)
            except Exception:
                pass
            break
    return duration_s, width, height, fps


async def seed() -> None:
    if not SEED_DIR.exists():
        return

    video_dir = DATA_DIR / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)

    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=2)
    try:
        # Apply schema before seeding (all DDL is IF NOT EXISTS — idempotent)
        schema_sql = (Path(__file__).parent / "schema.sql").read_text()
        async with pool.acquire() as conn:
            await conn.execute(schema_sql)

        for src in sorted(SEED_DIR.glob("*.mp4")):
            stem = re.sub(r"[^a-zA-Z0-9_-]", "_", src.stem)
            video_id = stem
            dest = video_dir / src.name

            # Copy file if missing
            if not dest.exists():
                shutil.copy2(src, dest)
                log.info("seed.file.copied name=%s", src.name)

            # Skip DB insert if row already exists
            exists = await pool.fetchval("SELECT 1 FROM uploads WHERE video_id=$1", video_id)
            if exists:
                log.info("seed.db.skip video_id=%s", video_id)
                continue

            duration_s, width, height, fps = probe(dest)
            size_bytes = dest.stat().st_size

            await pool.execute(
                """
                INSERT INTO uploads (video_id, original_filename, duration_s, width, height, fps, size_bytes)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (video_id) DO NOTHING
                """,
                video_id,
                src.name,
                duration_s,
                width,
                height,
                fps,
                size_bytes,
            )
            log.info("seed.db.inserted video_id=%s duration_s=%s", video_id, duration_s)
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(seed())
