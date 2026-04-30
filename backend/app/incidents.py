"""Incidents API — rule-detected traffic incidents for an upload."""

import json

from fastapi import APIRouter, HTTPException

from app.db import get_pool

router = APIRouter()


def _jsonb(value):
    # asyncpg returns JSONB as raw text unless a codec is registered on the pool.
    # Parse here so the API contract returns objects, not strings.
    if isinstance(value, str):
        return json.loads(value)
    return value


def _incident_record(row) -> dict:
    return {
        "id": str(row["id"]),
        "video_id": row["video_id"],
        "rule_id": row["rule_id"],
        "severity": row["severity"],
        "confidence": row["confidence"],
        "t_start_s": row["t_start_s"],
        "t_end_s": row["t_end_s"],
        "frame_start": row["frame_start"],
        "frame_end": row["frame_end"],
        "track_ids": list(row["track_ids"]),
        "bbox_union": _jsonb(row["bbox_union"]),
        "metadata": _jsonb(row["metadata"]),
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/api/uploads/{video_id}/incidents")
async def get_incidents(video_id: str):
    pool = get_pool()

    exists = await pool.fetchval("SELECT 1 FROM uploads WHERE video_id=$1", video_id)
    if not exists:
        raise HTTPException(status_code=404, detail="Upload not found")

    rows = await pool.fetch(
        """
        SELECT id, video_id, rule_id, severity, confidence,
               t_start_s, t_end_s, frame_start, frame_end,
               track_ids, bbox_union, metadata, created_at
        FROM incidents
        WHERE video_id = $1
        ORDER BY t_start_s
        """,
        video_id,
    )
    return {"incidents": [_incident_record(r) for r in rows]}


@router.post("/api/uploads/{video_id}/analyze")
async def analyze_upload(video_id: str):
    from app.incident_worker import run_incident_detection

    pool = get_pool()

    exists = await pool.fetchval("SELECT 1 FROM uploads WHERE video_id=$1", video_id)
    if not exists:
        raise HTTPException(status_code=404, detail="Upload not found")

    event_count = await pool.fetchval(
        "SELECT COUNT(*) FROM events WHERE video_id=$1", video_id
    )
    if not event_count:
        raise HTTPException(status_code=422, detail="Upload has no events yet")

    count = await run_incident_detection(video_id, pool)
    return {"incidents_found": count}
