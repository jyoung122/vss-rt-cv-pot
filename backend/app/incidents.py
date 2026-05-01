"""Incidents API — rule-detected traffic incidents for an upload."""

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException

from app.db import get_pool
from app.logging_config import Timer, log_context, new_run_id

router = APIRouter()
log = logging.getLogger(__name__)


def _jsonb(value):
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
        "vlm_status": row["vlm_status"],
        "vlm_verdict": row["vlm_verdict"],
        "vlm_reasoning": row["vlm_reasoning"],
        "vlm_confidence": row["vlm_confidence"],
        "vlm_model": row["vlm_model"],
        "vlm_clip_path": row["vlm_clip_path"],
        "vlm_latency_ms": row["vlm_latency_ms"],
        "vlm_at": row["vlm_at"].isoformat() if row["vlm_at"] else None,
    }


_RULE_ORDER = ["vehicle_collision", "ped_impact", "stationary_vehicle", "mass_stop"]
_RULE_SEVERITY = {
    "vehicle_collision": "high",
    "ped_impact": "high",
    "stationary_vehicle": "medium",
    "mass_stop": "low",
}


@router.get("/api/incidents/catalog")
async def get_incident_catalog():
    """Aggregate stats per rule type across all videos, including 5 most-recent incidents each."""
    pool = get_pool()

    agg_rows = await pool.fetch(
        """
        SELECT
            rule_id,
            COUNT(*)                                                        AS total,
            ROUND(AVG(confidence)::numeric, 3)                              AS avg_confidence,
            COUNT(*) FILTER (WHERE vlm_status = 'done' AND vlm_verdict = 'confirmed') AS vlm_confirmed,
            COUNT(*) FILTER (WHERE vlm_status = 'done' AND vlm_verdict = 'rejected')  AS vlm_rejected,
            COUNT(*) FILTER (WHERE vlm_status = 'pending')                 AS vlm_pending,
            COUNT(*) FILTER (WHERE vlm_status = 'done')                    AS vlm_done,
            MAX(created_at)                                                 AS last_detected_at
        FROM incidents
        GROUP BY rule_id
        """
    )
    agg = {r["rule_id"]: r for r in agg_rows}

    catalog = []
    for rule_id in _RULE_ORDER:
        row = agg.get(rule_id)
        total = int(row["total"]) if row else 0
        vlm_done = int(row["vlm_done"]) if row else 0
        vlm_confirmed = int(row["vlm_confirmed"]) if row else 0
        vlm_rejected = int(row["vlm_rejected"]) if row else 0

        recent_rows = await pool.fetch(
            """
            SELECT id, video_id, rule_id, severity, confidence,
                   t_start_s, t_end_s, track_ids, metadata, created_at,
                   vlm_status, vlm_verdict, vlm_confidence
            FROM incidents
            WHERE rule_id = $1
            ORDER BY created_at DESC
            LIMIT 5
            """,
            rule_id,
        ) if total > 0 else []

        catalog.append({
            "rule_id": rule_id,
            "severity": _RULE_SEVERITY.get(rule_id, "medium"),
            "total": total,
            "avg_confidence": float(row["avg_confidence"]) if row and row["avg_confidence"] else 0.0,
            "vlm_confirmed": vlm_confirmed,
            "vlm_rejected": vlm_rejected,
            "vlm_pending": int(row["vlm_pending"]) if row else 0,
            "false_positive_rate": round(vlm_rejected / vlm_done, 3) if vlm_done > 0 else None,
            "last_detected_at": row["last_detected_at"].isoformat() if row and row["last_detected_at"] else None,
            "recent_incidents": [
                {
                    "id": str(r["id"]),
                    "video_id": r["video_id"],
                    "confidence": r["confidence"],
                    "t_start_s": r["t_start_s"],
                    "t_end_s": r["t_end_s"],
                    "track_ids": list(r["track_ids"]),
                    "metadata": _jsonb(r["metadata"]),
                    "created_at": r["created_at"].isoformat(),
                    "vlm_status": r["vlm_status"],
                    "vlm_verdict": r["vlm_verdict"],
                    "vlm_confidence": r["vlm_confidence"],
                }
                for r in recent_rows
            ],
        })

    log.info("incidents.catalog.complete", extra={"rule_count": len(catalog)})
    return {"catalog": catalog}


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
               track_ids, bbox_union, metadata, created_at,
               vlm_status, vlm_verdict, vlm_reasoning, vlm_confidence,
               vlm_model, vlm_clip_path, vlm_latency_ms, vlm_at
        FROM incidents
        WHERE video_id = $1
        ORDER BY t_start_s
        """,
        video_id,
    )
    log.info("incidents.list.complete", extra={"video_id": video_id, "incident_count": len(rows)})
    return {"incidents": [_incident_record(r) for r in rows]}


@router.post("/api/uploads/{video_id}/analyze")
async def analyze_upload(video_id: str):
    from app.incident_worker import run_incident_detection
    from app.vlm_validator import run_vlm_validation

    run_id = new_run_id()
    pool = get_pool()

    with log_context(run_id=run_id, video_id=video_id):
        timer = Timer()
        log.info("analyze.run.start")

        exists = await pool.fetchval("SELECT 1 FROM uploads WHERE video_id=$1", video_id)
        if not exists:
            log.warning("analyze.upload.not_found")
            raise HTTPException(status_code=404, detail="Upload not found")

        event_count = await pool.fetchval(
            "SELECT COUNT(*) FROM events WHERE video_id=$1", video_id
        )
        if not event_count:
            log.warning("analyze.upload.no_events")
            raise HTTPException(status_code=422, detail="Upload has no events yet")

        count = await run_incident_detection(video_id, pool)

        # VLM validation runs in background; vlm_validator handles VLM_ENABLED=false → skipped.
        asyncio.create_task(run_vlm_validation(video_id, pool))

        log.info(
            "analyze.run.complete",
            extra={"duration_ms": timer.duration_ms, "event_count": event_count, "incident_count": count},
        )
        return {"incidents_found": count}
