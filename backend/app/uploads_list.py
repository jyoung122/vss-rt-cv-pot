"""Uploads CRUD API backed by Postgres."""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from app.db import get_pool
import app.upload_queue as upload_queue

DATA_DIR = os.getenv("DATA_DIR", "/data")

router = APIRouter()

ALLOWED_SUFFIXES = [".mp4", ".mkv"]


def _upload_record(row, event_count: int, track_count: int) -> dict:
    vid = row["video_id"]
    thumb = Path(DATA_DIR) / "thumbs" / f"{vid}.jpg"
    return {
        "video_id": vid,
        "original_filename": row["original_filename"],
        "prompt": row["prompt"],
        "duration_s": row["duration_s"],
        "width": row["width"],
        "height": row["height"],
        "fps": row["fps"],
        "size_bytes": row["size_bytes"],
        "uploaded_at": row["uploaded_at"].isoformat(),
        "playback_url": f"/api/video/{vid}",
        "thumbnail_url": f"/api/thumbs/{vid}" if thumb.exists() else None,
        "event_count": event_count,
        "track_count": track_count,
    }


@router.get("/api/uploads")
async def list_uploads():
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT
            u.*,
            COALESCE(e.event_count, 0)::int AS event_count,
            COALESCE(e.track_count, 0)::int AS track_count
        FROM uploads u
        LEFT JOIN (
            SELECT video_id,
                   COUNT(*)           AS event_count,
                   COUNT(DISTINCT track_id) AS track_count
            FROM events
            GROUP BY video_id
        ) e ON e.video_id = u.video_id
        ORDER BY u.uploaded_at DESC
        """
    )
    return {"uploads": [_upload_record(r, r["event_count"], r["track_count"]) for r in rows]}


@router.get("/api/uploads/{video_id}")
async def get_upload(video_id: str):
    pool = get_pool()
    row = await pool.fetchrow(
        """
        SELECT
            u.*,
            COALESCE(e.event_count, 0)::int AS event_count,
            COALESCE(e.track_count, 0)::int AS track_count
        FROM uploads u
        LEFT JOIN (
            SELECT video_id,
                   COUNT(*)           AS event_count,
                   COUNT(DISTINCT track_id) AS track_count
            FROM events
            WHERE video_id = $1
            GROUP BY video_id
        ) e ON e.video_id = u.video_id
        WHERE u.video_id = $1
        """,
        video_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    return _upload_record(row, row["event_count"], row["track_count"])


@router.get("/api/thumbs/{video_id}")
async def get_thumbnail(video_id: str):
    thumb = Path(DATA_DIR) / "thumbs" / f"{video_id}.jpg"
    if not thumb.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(str(thumb), media_type="image/jpeg")


@router.delete("/api/uploads/{video_id}")
async def delete_upload(video_id: str):
    pool = get_pool()
    result = await pool.execute("DELETE FROM uploads WHERE video_id=$1", video_id)
    # asyncpg returns "DELETE <count>"
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Upload not found")

    # Remove the video file and thumbnail (tolerate already-gone)
    video_dir = Path(DATA_DIR) / "videos"
    for suffix in ALLOWED_SUFFIXES:
        candidate = video_dir / f"{video_id}{suffix}"
        candidate.unlink(missing_ok=True)
    (Path(DATA_DIR) / "thumbs" / f"{video_id}.jpg").unlink(missing_ok=True)

    return Response(status_code=204)


@router.get("/api/uploads/{video_id}/progress")
async def get_upload_progress(video_id: str):
    vlm_enabled = os.environ.get("VLM_ENABLED", "false").lower() == "true"
    pool = get_pool()
    row = await pool.fetchrow(
        """
        SELECT
            u.video_id,
            u.duration_s,
            COALESCE(e.event_count, 0)::int AS event_count,
            COALESCE(i.incidents_total, 0)::int AS incidents_total,
            COALESCE(i.vlm_pending, 0)::int AS vlm_pending,
            COALESCE(i.vlm_done, 0)::int AS vlm_done,
            COALESCE(i.vlm_skipped, 0)::int AS vlm_skipped,
            COALESCE(i.vlm_error, 0)::int AS vlm_error
        FROM uploads u
        LEFT JOIN (
            SELECT video_id, COUNT(*) AS event_count
            FROM events
            WHERE video_id = $1
            GROUP BY video_id
        ) e ON e.video_id = u.video_id
        LEFT JOIN (
            SELECT
                video_id,
                COUNT(*)::int AS incidents_total,
                COUNT(*) FILTER (WHERE vlm_status = 'pending')::int AS vlm_pending,
                COUNT(*) FILTER (WHERE vlm_status = 'done')::int AS vlm_done,
                COUNT(*) FILTER (WHERE vlm_status = 'skipped')::int AS vlm_skipped,
                COUNT(*) FILTER (WHERE vlm_status = 'error')::int AS vlm_error
            FROM incidents
            WHERE video_id = $1
            GROUP BY video_id
        ) i ON i.video_id = u.video_id
        WHERE u.video_id = $1
        """,
        video_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Upload not found")

    # Determine queue fields
    video_id_str = row["video_id"]
    active_id = upload_queue.get_active_job_id()
    queue_pos = upload_queue.get_queue_position(video_id_str)

    if active_id == video_id_str:
        queue_status: str | None = "active"
        queue_position: int | None = None
    elif queue_pos is not None:
        queue_status = "queued"
        queue_position = queue_pos
    else:
        # Check if processing has completed (has events or incidents, or was
        # previously active). We use a simple heuristic: if it's not in the
        # queue and not active, it's either "done" (processed via queue) or
        # null (legacy / never queued). We expose "done" if vlm_done+vlm_skipped+vlm_error>0
        # OR event_count > 0, otherwise null.
        has_data = (
            row["event_count"] > 0
            or row["incidents_total"] > 0
        )
        queue_status = "done" if has_data else None
        queue_position = None

    return {
        "video_id": video_id_str,
        "duration_s": row["duration_s"],
        "event_count": row["event_count"],
        "incidents_total": row["incidents_total"],
        "vlm_pending": row["vlm_pending"],
        "vlm_done": row["vlm_done"],
        "vlm_skipped": row["vlm_skipped"],
        "vlm_error": row["vlm_error"],
        "vlm_enabled": vlm_enabled,
        "queue_status": queue_status,
        "queue_position": queue_position,
    }


@router.get("/api/uploads/{video_id}/events")
async def get_upload_events(video_id: str, group: str = "tracks"):
    pool = get_pool()

    # Verify the upload exists
    exists = await pool.fetchval("SELECT 1 FROM uploads WHERE video_id=$1", video_id)
    if not exists:
        raise HTTPException(status_code=404, detail="Upload not found")

    if group == "none":
        rows = await pool.fetch(
            """
            SELECT track_id, class, frame_id, t_seconds, confidence,
                   bbox_x1, bbox_y1, bbox_x2, bbox_y2
            FROM events
            WHERE video_id = $1
            ORDER BY frame_id
            LIMIT 50000
            """,
            video_id,
        )
        detections = [
            {
                "track_id": r["track_id"],
                "class": r["class"],
                "frame_id": r["frame_id"],
                "t_seconds": r["t_seconds"],
                "confidence": r["confidence"],
                "bbox": {
                    "x1": r["bbox_x1"],
                    "y1": r["bbox_y1"],
                    "x2": r["bbox_x2"],
                    "y2": r["bbox_y2"],
                },
            }
            for r in rows
        ]
        return {"events": detections}

    # Default: group=tracks
    # Get per-track aggregate + bbox of first detection via DISTINCT ON
    rows = await pool.fetch(
        """
        WITH first_bbox AS (
            SELECT DISTINCT ON (track_id)
                track_id,
                bbox_x1, bbox_y1, bbox_x2, bbox_y2
            FROM events
            WHERE video_id = $1
            ORDER BY track_id, frame_id
        )
        SELECT
            e.track_id,
            e.class,
            MIN(e.frame_id)     AS first_frame_id,
            MAX(e.frame_id)     AS last_frame_id,
            MIN(e.t_seconds)    AS first_t_seconds,
            MAX(e.t_seconds)    AS last_t_seconds,
            COUNT(*)::int       AS detection_count,
            MAX(e.confidence)   AS max_confidence,
            fb.bbox_x1, fb.bbox_y1, fb.bbox_x2, fb.bbox_y2
        FROM events e
        JOIN first_bbox fb ON fb.track_id = e.track_id
        WHERE e.video_id = $1
        GROUP BY e.track_id, e.class, fb.bbox_x1, fb.bbox_y1, fb.bbox_x2, fb.bbox_y2
        ORDER BY e.track_id
        """,
        video_id,
    )
    tracks = [
        {
            "track_id": r["track_id"],
            "class": r["class"],
            "first_t_seconds": r["first_t_seconds"],
            "last_t_seconds": r["last_t_seconds"],
            "duration_s": r["last_t_seconds"] - r["first_t_seconds"],
            "detection_count": r["detection_count"],
            "max_confidence": r["max_confidence"],
            "first_bbox": {
                "x1": r["bbox_x1"],
                "y1": r["bbox_y1"],
                "x2": r["bbox_x2"],
                "y2": r["bbox_y2"],
            },
        }
        for r in rows
    ]
    return {"events": tracks}
