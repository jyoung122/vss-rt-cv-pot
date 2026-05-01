"""Incidents API — rule-detected traffic incidents for an upload."""

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import get_pool
from app.logging_config import Timer, log_context, new_run_id

router = APIRouter()
log = logging.getLogger(__name__)


class ThresholdsBody(BaseModel):
    thresholds: dict[str, Any]


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
_VALID_RULES = set(_RULE_ORDER)


@router.get("/api/rules/{rule_id}/thresholds")
async def get_rule_thresholds(rule_id: str):
    """Return current thresholds for a rule, merged with code defaults."""
    if rule_id not in _VALID_RULES:
        raise HTTPException(status_code=404, detail=f"Unknown rule: {rule_id}")
    from app.incident_worker import DEFAULT_THRESHOLDS, THRESHOLD_SCHEMA
    pool = get_pool()
    row = await pool.fetchrow("SELECT thresholds, updated_at FROM rule_config WHERE rule_id=$1", rule_id)
    overrides: dict = {}
    if row:
        raw = row["thresholds"]
        overrides = json.loads(raw) if isinstance(raw, str) else (raw or {})
    defaults = DEFAULT_THRESHOLDS[rule_id]
    merged = {**defaults, **overrides}
    return {
        "rule_id": rule_id,
        "thresholds": merged,
        "defaults": defaults,
        "schema": THRESHOLD_SCHEMA[rule_id],
        "updated_at": row["updated_at"].isoformat() if row else None,
    }


@router.put("/api/rules/{rule_id}/thresholds")
async def put_rule_thresholds(rule_id: str, body: ThresholdsBody):
    """Upsert threshold overrides for a rule. Only recognized keys are stored."""
    if rule_id not in _VALID_RULES:
        raise HTTPException(status_code=404, detail=f"Unknown rule: {rule_id}")
    from app.incident_worker import DEFAULT_THRESHOLDS, THRESHOLD_SCHEMA
    valid_keys = {s["key"] for s in THRESHOLD_SCHEMA[rule_id]}
    filtered = {k: v for k, v in body.thresholds.items() if k in valid_keys}
    pool = get_pool()
    row = await pool.fetchrow(
        """
        INSERT INTO rule_config (rule_id, thresholds)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (rule_id) DO UPDATE
            SET thresholds = $2::jsonb, updated_at = now()
        RETURNING updated_at
        """,
        rule_id,
        json.dumps(filtered),
    )
    log.info("rules.thresholds.updated", extra={"rule_id": rule_id, "keys": list(filtered.keys())})
    return {
        "rule_id": rule_id,
        "thresholds": {**DEFAULT_THRESHOLDS[rule_id], **filtered},
        "updated_at": row["updated_at"].isoformat(),
    }


@router.post("/api/rules/{rule_id}/thresholds/reset")
async def reset_rule_thresholds(rule_id: str):
    """Delete any DB overrides, reverting to code defaults."""
    if rule_id not in _VALID_RULES:
        raise HTTPException(status_code=404, detail=f"Unknown rule: {rule_id}")
    from app.incident_worker import DEFAULT_THRESHOLDS
    pool = get_pool()
    await pool.execute("DELETE FROM rule_config WHERE rule_id=$1", rule_id)
    log.info("rules.thresholds.reset", extra={"rule_id": rule_id})
    return {"rule_id": rule_id, "thresholds": DEFAULT_THRESHOLDS[rule_id], "updated_at": None}



_RULE_SEVERITY = {
    "vehicle_collision": "high",
    "ped_impact": "high",
    "stationary_vehicle": "medium",
    "mass_stop": "low",
}


@router.get("/api/incidents/catalog")
async def get_incident_catalog():  # noqa: C901
    """Aggregate stats per rule type, current thresholds, and 5 most-recent incidents each."""
    from app.incident_worker import DEFAULT_THRESHOLDS, THRESHOLD_SCHEMA
    pool = get_pool()

    # Load all rule_config rows in one query
    cfg_rows = await pool.fetch("SELECT rule_id, thresholds, updated_at FROM rule_config")
    cfg_map: dict[str, dict] = {}
    cfg_updated: dict[str, str] = {}
    for cr in cfg_rows:
        raw = cr["thresholds"]
        cfg_map[cr["rule_id"]] = json.loads(raw) if isinstance(raw, str) else (raw or {})
        cfg_updated[cr["rule_id"]] = cr["updated_at"].isoformat()

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

        defaults = DEFAULT_THRESHOLDS[rule_id]
        overrides = cfg_map.get(rule_id, {})
        merged_thresholds = {**defaults, **overrides}

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
            "thresholds": merged_thresholds,
            "threshold_schema": THRESHOLD_SCHEMA[rule_id],
            "thresholds_updated_at": cfg_updated.get(rule_id),
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
