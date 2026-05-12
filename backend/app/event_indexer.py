"""Background task: consumes mdx-raw Redis stream via XREADGROUP and inserts
detection events into Postgres.
"""

import asyncio
import json
import logging
import time

import redis.asyncio as aioredis

log = logging.getLogger(__name__)

STREAM_NAME = "mdx-raw"
GROUP_NAME = "indexer"
CONSUMER_NAME = "indexer-1"
HEALTH_LOG_INTERVAL_S = 10.0

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


async def _stream_lag(r) -> int | None:
    try:
        groups = await r.xinfo_groups(STREAM_NAME)
    except Exception:
        return None
    for group in groups:
        if group.get("name") == GROUP_NAME:
            lag = group.get("lag")
            return int(lag) if lag is not None else None
    return None


async def run_indexer(redis_url: str) -> None:
    """Main indexer loop.  Designed to run forever; catches all exceptions."""
    from app.db import get_pool  # late import to avoid circular at module load

    log.info(
        "event_indexer.consumer.start",
        extra={"stream": STREAM_NAME, "consumer_group": GROUP_NAME, "consumer": CONSUMER_NAME},
    )

    while True:
        try:
            r = aioredis.from_url(redis_url, decode_responses=True)
            async with r:
                # Ensure the consumer group exists (MKSTREAM creates the stream
                # if it doesn't exist yet).
                try:
                    await r.xgroup_create(STREAM_NAME, GROUP_NAME, id="0", mkstream=True)
                    log.info(
                        "event_indexer.consumer_group.created",
                        extra={"stream": STREAM_NAME, "consumer_group": GROUP_NAME},
                    )
                except aioredis.ResponseError as exc:
                    if "BUSYGROUP" not in str(exc):
                        raise
                    log.info(
                        "event_indexer.consumer_group.ready",
                        extra={"stream": STREAM_NAME, "consumer_group": GROUP_NAME},
                    )

                pool = get_pool()
                stats = {
                    "entries_read": 0,
                    "rows_inserted": 0,
                    "malformed_objects": 0,
                    "orphan_entries": 0,
                    "entry_errors": 0,
                }
                interval_started = time.monotonic()
                last_health_log = interval_started

                async def emit_health(force: bool = False) -> None:
                    nonlocal interval_started, last_health_log, stats
                    now = time.monotonic()
                    if not force and now - last_health_log < HEALTH_LOG_INTERVAL_S:
                        return
                    lag = await _stream_lag(r)
                    log.info(
                        "event_indexer.consumer.health",
                        extra={
                            "stream": STREAM_NAME,
                            "consumer_group": GROUP_NAME,
                            "consumer": CONSUMER_NAME,
                            "event_count": stats["entries_read"],
                            "detection_count": stats["rows_inserted"],
                            "malformed_objects": stats["malformed_objects"],
                            "orphan_entries": stats["orphan_entries"],
                            "entry_errors": stats["entry_errors"],
                            "stream_lag": lag,
                            "duration_ms": int((now - interval_started) * 1000),
                        },
                    )
                    stats = {key: 0 for key in stats}
                    interval_started = now
                    last_health_log = now

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
                        await emit_health()
                        continue

                    for _stream, entries in messages:
                        for entry_id, fields in entries:
                            try:
                                stats["entries_read"] += 1
                                raw = fields.get("metadata") or fields.get("msg", "{}")
                                meta = json.loads(raw)

                                frame_id = int(meta.get("id", 0))

                                # F1: route every frame by msgconv's sensorId
                                # (= camera_id we passed to /api/v1/stream/add =
                                # our video_id). The previous Redis singleton
                                # `current_video_id` was last-writer-wins and
                                # broke under N>1 concurrent uploads.
                                current_video_id = meta.get("sensorId")
                                if not current_video_id:
                                    # Orphan frame — no sensorId. Could be from
                                    # the pre-F2 static [source0] config or a
                                    # malformed payload.
                                    stats["orphan_entries"] += 1
                                    await r.xack(STREAM_NAME, GROUP_NAME, entry_id)
                                    continue

                                fps = await _get_fps(pool, current_video_id)
                                if fps is None:
                                    # sensorId doesn't match any known upload
                                    # (stale source-add or pre-F2 sensor0).
                                    # Drop to avoid FK violation on insert.
                                    stats["orphan_entries"] += 1
                                    await r.xack(STREAM_NAME, GROUP_NAME, entry_id)
                                    continue
                                t_seconds = frame_id / fps

                                objects = meta.get("objects", [])
                                rows = []
                                for obj_str in objects:
                                    parsed = _parse_object(obj_str)
                                    if parsed is None:
                                        stats["malformed_objects"] += 1
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

                                log.debug(
                                    "event_indexer.frame.parsed",
                                    extra={
                                        "video_id": current_video_id,
                                        "entry_id": entry_id,
                                        "frame_id": frame_id,
                                        "object_count": len(objects),
                                        "rows_inserted": len(rows),
                                    },
                                )

                                if rows:
                                    # ON CONFLICT collapses duplicates from
                                    # DeepStream loop replays (-r 2). Without
                                    # this, every loop iteration appends a
                                    # fresh row per (frame_id, track_id),
                                    # corrupting per-track signals.
                                    await pool.executemany(
                                        """
                                        INSERT INTO events
                                            (video_id, track_id, frame_id, t_seconds,
                                             class, confidence,
                                             bbox_x1, bbox_y1, bbox_x2, bbox_y2)
                                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                                        ON CONFLICT (video_id, frame_id, track_id) DO NOTHING
                                        """,
                                        rows,
                                    )
                                    stats["rows_inserted"] += len(rows)

                                await r.xack(STREAM_NAME, GROUP_NAME, entry_id)

                            except Exception as exc:
                                stats["entry_errors"] += 1
                                log.exception("event_indexer.entry.error", extra={"entry_id": entry_id, "error": str(exc)})
                                # Still ack to avoid poison-pill looping.
                                try:
                                    await r.xack(STREAM_NAME, GROUP_NAME, entry_id)
                                except Exception:
                                    pass
                    await emit_health()

        except asyncio.CancelledError:
            log.info("event_indexer.consumer.cancelled")
            return
        except Exception as exc:
            log.exception("event_indexer.consumer.retry", extra={"error": str(exc)})
            await asyncio.sleep(2)
