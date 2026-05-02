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


@router.get("/api/analytics/summary")
async def get_analytics_summary():
    """Aggregated analytics data: totals, daily trend (30d), heatmap, per-rule breakdown."""
    pool = get_pool()

    # Overall totals
    agg = await pool.fetchrow(
        """
        SELECT
            COUNT(*)                                                                  AS total,
            COUNT(*) FILTER (WHERE vlm_status = 'done' AND vlm_verdict = 'confirmed') AS vlm_confirmed,
            COUNT(*) FILTER (WHERE vlm_status = 'done' AND vlm_verdict = 'rejected')  AS vlm_rejected,
            COUNT(*) FILTER (WHERE vlm_status = 'pending')                            AS vlm_pending,
            COUNT(*) FILTER (WHERE vlm_status = 'done')                               AS vlm_done
        FROM incidents
        """
    )
    total = int(agg["total"])
    vlm_done = int(agg["vlm_done"])
    fp_rate = round(int(agg["vlm_rejected"]) / vlm_done, 4) if vlm_done > 0 else None

    # Per-rule breakdown
    rule_rows = await pool.fetch(
        """
        SELECT
            rule_id,
            COUNT(*)                                                                  AS total,
            COUNT(*) FILTER (WHERE vlm_status = 'done' AND vlm_verdict = 'confirmed') AS vlm_confirmed,
            COUNT(*) FILTER (WHERE vlm_status = 'done' AND vlm_verdict = 'rejected')  AS vlm_rejected,
            COUNT(*) FILTER (WHERE vlm_status = 'done')                               AS vlm_done,
            ROUND(AVG(confidence)::numeric, 3)                                        AS avg_confidence
        FROM incidents
        GROUP BY rule_id
        """
    )
    by_rule = [
        {
            "rule_id": r["rule_id"],
            "total": int(r["total"]),
            "vlm_confirmed": int(r["vlm_confirmed"]),
            "vlm_rejected": int(r["vlm_rejected"]),
            "false_positive_rate": round(int(r["vlm_rejected"]) / int(r["vlm_done"]), 4)
                if int(r["vlm_done"]) > 0 else None,
            "avg_confidence": float(r["avg_confidence"]) if r["avg_confidence"] else 0.0,
        }
        for r in rule_rows
    ]

    # By severity
    sev_rows = await pool.fetch(
        "SELECT severity, COUNT(*) AS count FROM incidents GROUP BY severity"
    )
    by_severity = [{"severity": r["severity"], "count": int(r["count"])} for r in sev_rows]

    # Daily counts per rule — last 30 days
    daily_rows = await pool.fetch(
        """
        SELECT
            date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
            rule_id,
            COUNT(*) AS count
        FROM incidents
        WHERE created_at >= now() - interval '30 days'
        GROUP BY 1, 2
        ORDER BY 1
        """
    )
    # Build a dict keyed by date string
    daily_map: dict[str, dict] = {}
    for r in daily_rows:
        ds = r["day"].isoformat()
        daily_map.setdefault(ds, {})
        daily_map[ds][r["rule_id"]] = int(r["count"])

    # Heatmap: day-of-week (0=Mon) × hour → count
    heat_rows = await pool.fetch(
        """
        SELECT
            ((EXTRACT(DOW FROM created_at AT TIME ZONE 'UTC')::int + 6) % 7) AS dow,
            EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int             AS hour,
            COUNT(*)                                                           AS count
        FROM incidents
        GROUP BY 1, 2
        """
    )
    # 7 × 24 grid, dow 0=Mon
    heatmap = [[0] * 24 for _ in range(7)]
    for r in heat_rows:
        heatmap[int(r["dow"])][int(r["hour"])] = int(r["count"])

    return {
        "total": total,
        "vlm_confirmed": int(agg["vlm_confirmed"]),
        "vlm_rejected": int(agg["vlm_rejected"]),
        "vlm_pending": int(agg["vlm_pending"]),
        "false_positive_rate": fp_rate,
        "by_rule": by_rule,
        "by_severity": by_severity,
        "daily": daily_map,
        "heatmap": heatmap,
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


@router.get("/api/incidents/feed")
async def get_incidents_feed(limit: int = 100, offset: int = 0):
    """Cross-upload incident feed, newest first, joined with upload filename."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT i.id, i.video_id, u.original_filename,
               i.rule_id, i.severity, i.confidence,
               i.t_start_s, i.t_end_s,
               i.vlm_status, i.vlm_verdict, i.vlm_confidence,
               i.created_at
        FROM incidents i
        JOIN uploads u ON u.video_id = i.video_id
        ORDER BY i.created_at DESC
        LIMIT $1 OFFSET $2
        """,
        limit,
        offset,
    )
    total = await pool.fetchval("SELECT COUNT(*) FROM incidents")
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "incidents": [
            {
                "id": str(r["id"]),
                "video_id": r["video_id"],
                "original_filename": r["original_filename"],
                "rule_id": r["rule_id"],
                "severity": r["severity"],
                "confidence": round(float(r["confidence"]), 3),
                "t_start_s": r["t_start_s"],
                "t_end_s": r["t_end_s"],
                "vlm_status": r["vlm_status"],
                "vlm_verdict": r["vlm_verdict"],
                "vlm_confidence": round(float(r["vlm_confidence"]), 3) if r["vlm_confidence"] else None,
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ],
    }


@router.get("/api/incidents/{incident_id}")
async def get_incident(incident_id: str):
    """Get a single incident by ID, joined with upload filename."""
    pool = get_pool()
    try:
        row = await pool.fetchrow(
            """
            SELECT i.id, i.video_id, u.original_filename,
                   i.rule_id, i.severity, i.confidence,
                   i.t_start_s, i.t_end_s, i.frame_start, i.frame_end,
                   i.track_ids, i.bbox_union, i.metadata,
                   i.vlm_status, i.vlm_verdict, i.vlm_reasoning, i.vlm_confidence,
                   i.vlm_model, i.vlm_clip_path, i.vlm_latency_ms, i.vlm_at,
                   i.created_at
            FROM incidents i
            JOIN uploads u ON u.video_id = i.video_id
            WHERE i.id = $1::uuid
            """,
            incident_id,
        )
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid incident ID")
    if not row:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {
        "id": str(row["id"]),
        "video_id": row["video_id"],
        "original_filename": row["original_filename"],
        "rule_id": row["rule_id"],
        "severity": row["severity"],
        "confidence": round(float(row["confidence"]), 3),
        "t_start_s": row["t_start_s"],
        "t_end_s": row["t_end_s"],
        "frame_start": row["frame_start"],
        "frame_end": row["frame_end"],
        "track_ids": list(row["track_ids"]),
        "bbox_union": _jsonb(row["bbox_union"]),
        "metadata": _jsonb(row["metadata"]),
        "vlm_status": row["vlm_status"],
        "vlm_verdict": row["vlm_verdict"],
        "vlm_reasoning": row["vlm_reasoning"],
        "vlm_confidence": round(float(row["vlm_confidence"]), 3) if row["vlm_confidence"] else None,
        "vlm_model": row["vlm_model"],
        "vlm_clip_path": row["vlm_clip_path"],
        "vlm_latency_ms": row["vlm_latency_ms"],
        "vlm_at": row["vlm_at"].isoformat() if row["vlm_at"] else None,
        "created_at": row["created_at"].isoformat(),
    }


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
