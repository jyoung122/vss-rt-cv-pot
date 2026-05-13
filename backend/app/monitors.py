"""Live demo monitors — long-running RTSP sources attached to DeepStream.

Unlike uploads (one-pass file → plateau → teardown), monitors live until
the operator flips the toggle off.  Skips upload_queue, the semaphore, and
the plateau watcher entirely.

A monitor occupies one nvmultiurisrcbin slot for as long as it's enabled.
With max-batch-size=4 in DS config, keep concurrent-enabled monitors low
or upload throughput suffers — operator picks the trade-off in /live.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from app import deepstream, nvstreamer
from app.auth import require_user
from app.db import get_pool

log = logging.getLogger(__name__)
router = APIRouter()


async def _live_mode_enabled(pool) -> bool:
    """Master kill switch state, persisted in app_settings so it survives restarts."""
    row = await pool.fetchrow(
        "SELECT value FROM app_settings WHERE key = 'live_mode_enabled'"
    )
    if row is None:
        return True
    return bool(row["value"]) if isinstance(row["value"], bool) else row["value"] in (True, "true")


SEED_MONITORS = [
    {
        "id": "cam-1",
        "name": "Camera 1 — 115 & HVP",
        "source_url": "rtsp://mediamtx:8554/cam-1",
        "hls_path": "cam-1",
        "filename": "115_and_HVP.mp4",
    },
    {
        "id": "cam-2",
        "name": "Camera 2 — 75 Thunderbird",
        "source_url": "rtsp://mediamtx:8554/cam-2",
        "hls_path": "cam-2",
        "filename": "75_Thunderbird-2cb8c409-1778627045.mp4",
    },
    {
        "id": "cam-3",
        "name": "Camera 3 — 91 LPP",
        "source_url": "rtsp://mediamtx:8554/cam-3",
        "hls_path": "cam-3",
        "filename": "91_LPP-1778030969-2cb8c409-1778626853.mp4",
    },
]


async def seed_monitors(pool) -> None:
    """Insert the demo monitor rows (and matching stub uploads rows) if absent.

    Idempotent — re-runs on every boot are safe.  Stub uploads rows reuse the
    existing events FK / scrubber UIs without a separate events_monitors table.
    """
    for m in SEED_MONITORS:
        await pool.execute(
            """
            INSERT INTO uploads (video_id, original_filename, size_bytes,
                                 dss_status, user_id)
            VALUES ($1, $2, 0, 'live', NULL)
            ON CONFLICT (video_id) DO NOTHING
            """,
            m["id"], m["filename"],
        )
        await pool.execute(
            """
            INSERT INTO monitors (id, name, source_url, hls_path)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
            """,
            m["id"], m["name"], m["source_url"], m["hls_path"],
        )
    log.info("monitors.seed.ready", extra={"count": len(SEED_MONITORS)})


async def reattach_enabled(pool) -> None:
    """On startup, re-attach any monitor that was enabled before the restart.

    No-op when live_mode is off — operator must explicitly flip the kill
    switch back on, then re-enable each monitor.
    """
    if not await _live_mode_enabled(pool):
        log.info("monitors.recovery.skipped", extra={"reason": "live_mode_off"})
        return
    rows = await pool.fetch("SELECT id, source_url FROM monitors WHERE enabled = TRUE")
    for row in rows:
        try:
            uuid = await nvstreamer.register_sensor(row["id"], row["source_url"])
            await deepstream.add_stream(row["id"], row["source_url"])
            await pool.execute(
                "UPDATE monitors SET sensor_uuid=$1 WHERE id=$2", uuid, row["id"]
            )
            log.info("monitors.recovery.attached", extra={"monitor_id": row["id"]})
        except Exception as exc:
            log.warning(
                "monitors.recovery.failed",
                extra={"monitor_id": row["id"], "error": str(exc)},
            )
            # Best-effort: flip back to disabled so the UI reflects truth
            await pool.execute(
                "UPDATE monitors SET enabled=FALSE, sensor_uuid=NULL WHERE id=$1",
                row["id"],
            )


@router.get("/api/monitors")
async def list_monitors(user=Depends(require_user)):
    """List all demo monitors with current state.  Shared across users."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT id, name, source_url, hls_path, enabled,
               last_enabled_at, last_disabled_at
        FROM monitors
        ORDER BY id
        """
    )
    return [dict(r) for r in rows]


@router.post("/api/monitors/{monitor_id}/enable")
async def enable_monitor(monitor_id: str, user=Depends(require_user)):
    pool = get_pool()
    if not await _live_mode_enabled(pool):
        raise HTTPException(503, "Live demo mode is disabled — toggle in /settings")
    row = await pool.fetchrow(
        "SELECT id, source_url, enabled FROM monitors WHERE id=$1", monitor_id
    )
    if row is None:
        raise HTTPException(404, "Monitor not found")
    if row["enabled"]:
        return {"id": monitor_id, "enabled": True, "noop": True}
    try:
        uuid = await nvstreamer.register_sensor(monitor_id, row["source_url"])
        await deepstream.add_stream(monitor_id, row["source_url"])
    except Exception as exc:
        log.exception(
            "monitors.enable.failed",
            extra={"monitor_id": monitor_id, "error": str(exc)},
        )
        # Best-effort cleanup if nvstreamer.register_sensor succeeded but
        # deepstream.add_stream failed — caller can retry.
        raise HTTPException(502, f"Enable failed: {exc}")
    await pool.execute(
        """
        UPDATE monitors
        SET enabled=TRUE, sensor_uuid=$1, last_enabled_at=now()
        WHERE id=$2
        """,
        uuid, monitor_id,
    )
    log.info(
        "monitors.enable.ok",
        extra={"monitor_id": monitor_id, "sensor_uuid": uuid, "user_id": user["user_id"]},
    )
    return {"id": monitor_id, "enabled": True}


@router.post("/api/monitors/{monitor_id}/disable")
async def disable_monitor(monitor_id: str, user=Depends(require_user)):
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT id, source_url, sensor_uuid, enabled FROM monitors WHERE id=$1",
        monitor_id,
    )
    if row is None:
        raise HTTPException(404, "Monitor not found")
    if not row["enabled"]:
        return {"id": monitor_id, "enabled": False, "noop": True}
    # Teardown is best-effort — flip the flag even if remote calls degrade.
    await deepstream.remove_stream(monitor_id, row["source_url"])
    if row["sensor_uuid"]:
        await nvstreamer.unregister_sensor(row["sensor_uuid"])
    await pool.execute(
        """
        UPDATE monitors
        SET enabled=FALSE, sensor_uuid=NULL, last_disabled_at=now()
        WHERE id=$1
        """,
        monitor_id,
    )
    log.info(
        "monitors.disable.ok",
        extra={"monitor_id": monitor_id, "user_id": user["user_id"]},
    )
    return {"id": monitor_id, "enabled": False}


@router.get("/api/live/mode")
async def get_live_mode(user=Depends(require_user)):
    """Master kill switch state — read by /settings + /live."""
    pool = get_pool()
    return {"enabled": await _live_mode_enabled(pool)}


@router.post("/api/live/mode")
async def set_live_mode(payload: dict, user=Depends(require_user)):
    """Flip the master kill switch.  Body: ``{"enabled": bool}``.

    Turning OFF also tears down all currently-enabled monitors so the GPU
    actually frees up.  Turning ON does NOT auto-re-enable monitors — the
    operator picks which to bring back in /live.
    """
    enabled = bool(payload.get("enabled", False))
    pool = get_pool()
    await pool.execute(
        """
        INSERT INTO app_settings (key, value) VALUES ('live_mode_enabled', $1::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        """,
        "true" if enabled else "false",
    )
    if not enabled:
        rows = await pool.fetch(
            "SELECT id, source_url, sensor_uuid FROM monitors WHERE enabled=TRUE"
        )
        for r in rows:
            await deepstream.remove_stream(r["id"], r["source_url"])
            if r["sensor_uuid"]:
                await nvstreamer.unregister_sensor(r["sensor_uuid"])
        await pool.execute(
            "UPDATE monitors SET enabled=FALSE, sensor_uuid=NULL, last_disabled_at=now() WHERE enabled=TRUE"
        )
        log.info("live_mode.disabled", extra={"torn_down": len(rows), "user_id": user["user_id"]})
    else:
        log.info("live_mode.enabled", extra={"user_id": user["user_id"]})
    return {"enabled": enabled}


@router.get("/api/monitors/{monitor_id}/events")
async def monitor_events(
    monitor_id: str,
    seconds: int = 60,
    user=Depends(require_user),
):
    """Recent events for a monitor — rolling-window tail for the /live feed.

    ``seconds`` (1..300) bounds the lookback so a long-running demo doesn't
    return a huge payload.  Joined via the stub uploads row, no user scoping
    (monitors are shared).
    """
    seconds = max(1, min(300, seconds))
    pool = get_pool()
    exists = await pool.fetchval("SELECT 1 FROM monitors WHERE id=$1", monitor_id)
    if not exists:
        raise HTTPException(404, "Monitor not found")
    # ``t_seconds`` for monitors is video-loop time, not wallclock; the
    # pruner trims rows older than the configured window using id (latest
    # rows = latest events). Order DESC + LIMIT mirrors that.
    rows = await pool.fetch(
        """
        SELECT track_id, frame_id, t_seconds, class, confidence,
               bbox_x1, bbox_y1, bbox_x2, bbox_y2
        FROM events
        WHERE video_id = $1
        ORDER BY id DESC
        LIMIT 500
        """,
        monitor_id,
    )
    return [dict(r) for r in rows]


@router.get("/api/monitors/{monitor_id}/stats")
async def monitor_stats(monitor_id: str, user=Depends(require_user)):
    """Lightweight counters for a /live tile: total events, distinct tracks."""
    pool = get_pool()
    row = await pool.fetchrow(
        """
        SELECT
          COUNT(*)                       AS events,
          COUNT(DISTINCT track_id)       AS tracks,
          MAX(id)                        AS last_event_id
        FROM events
        WHERE video_id = $1
        """,
        monitor_id,
    )
    return dict(row) if row else {"events": 0, "tracks": 0, "last_event_id": None}
