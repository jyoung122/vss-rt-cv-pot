"""Background task: consumes mdx-raw Redis stream via XREADGROUP and inserts
detection events into Postgres.
"""

import asyncio
import json
import logging

import redis.asyncio as aioredis

log = logging.getLogger(__name__)

STREAM_NAME = "mdx-raw"
GROUP_NAME = "indexer"
CONSUMER_NAME = "indexer-1"

# Per-process fps cache: { video_id -> fps (float or None) }
_fps_cache: dict[str, float | None] = {}


async def _get_fps(pool, video_id: str) -> float | None:
    if video_id in _fps_cache:
        return _fps_cache[video_id]
    row = await pool.fetchrow("SELECT fps FROM uploads WHERE video_id=$1", video_id)
    fps = row["fps"] if row else None
    _fps_cache[video_id] = fps
    return fps


def _parse_object(obj_str: str) -> dict | None:
    """Parse a pipe-delimited object string.  Returns None if malformed."""
    parts = obj_str.split("|")
    if len(parts) < 13:
        return None
    try:
        return {
            "track_id": int(parts[0]),
            "x1": float(parts[1]),
            "y1": float(parts[2]),
            "x2": float(parts[3]),
            "y2": float(parts[4]),
            "class": parts[5],
            "confidence": float(parts[-1]),
        }
    except (ValueError, IndexError):
        return None


async def run_indexer(redis_url: str) -> None:
    """Main indexer loop.  Designed to run forever; catches all exceptions."""
    from app.db import get_pool  # late import to avoid circular at module load

    while True:
        try:
            r = aioredis.from_url(redis_url, decode_responses=True)
            async with r:
                # Ensure the consumer group exists (MKSTREAM creates the stream
                # if it doesn't exist yet).
                try:
                    await r.xgroup_create(STREAM_NAME, GROUP_NAME, id="0", mkstream=True)
                except aioredis.ResponseError as exc:
                    if "BUSYGROUP" not in str(exc):
                        raise

                pool = get_pool()

                while True:
                    # Block up to 2 s so we can be cancelled cleanly.
                    messages = await r.xreadgroup(
                        GROUP_NAME,
                        CONSUMER_NAME,
                        {STREAM_NAME: ">"},
                        count=100,
                        block=2000,
                    )

                    if not messages:
                        continue

                    for _stream, entries in messages:
                        for entry_id, fields in entries:
                            try:
                                raw = fields.get("metadata") or fields.get("msg", "{}")
                                meta = json.loads(raw)

                                frame_id = int(meta.get("id", 0))

                                # Determine which video this frame belongs to.
                                current_video_id = await r.get("current_video_id")
                                if not current_video_id:
                                    # Orphan frame — nothing loaded yet.
                                    await r.xack(STREAM_NAME, GROUP_NAME, entry_id)
                                    continue

                                fps = await _get_fps(pool, current_video_id)
                                t_seconds = frame_id / (fps if fps else 30.0)

                                objects = meta.get("objects", [])
                                rows = []
                                for obj_str in objects:
                                    parsed = _parse_object(obj_str)
                                    if parsed is None:
                                        continue
                                    rows.append((
                                        current_video_id,
                                        parsed["track_id"],
                                        frame_id,
                                        t_seconds,
                                        parsed["class"],
                                        parsed["confidence"],
                                        parsed["x1"],
                                        parsed["y1"],
                                        parsed["x2"],
                                        parsed["y2"],
                                    ))

                                if rows:
                                    await pool.executemany(
                                        """
                                        INSERT INTO events
                                            (video_id, track_id, frame_id, t_seconds,
                                             class, confidence,
                                             bbox_x1, bbox_y1, bbox_x2, bbox_y2)
                                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                                        """,
                                        rows,
                                    )

                                await r.xack(STREAM_NAME, GROUP_NAME, entry_id)

                            except Exception as exc:
                                log.exception("Error processing entry %s: %s", entry_id, exc)
                                # Still ack to avoid poison-pill looping.
                                try:
                                    await r.xack(STREAM_NAME, GROUP_NAME, entry_id)
                                except Exception:
                                    pass

        except asyncio.CancelledError:
            log.info("event_indexer cancelled — exiting")
            return
        except Exception as exc:
            log.exception("event_indexer outer loop error: %s — retrying in 2s", exc)
            await asyncio.sleep(2)
