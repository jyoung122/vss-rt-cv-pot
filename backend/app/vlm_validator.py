"""VLM validation worker — swappable provider (Cosmos or OpenAI).

Picks up incidents with vlm_status='pending', extracts a clip via ffmpeg,
delegates to the configured VLM provider, parses the verdict, and writes back.

VLM_ENABLED=false (default) → marks all pending incidents 'skipped'.
Provider selection via VLM_PROVIDER=cosmos|openai (default: cosmos).
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path

log = logging.getLogger(__name__)

VLM_ENABLED = os.getenv("VLM_ENABLED", "false").lower() == "true"
CLIP_PAD_S = float(os.getenv("VLM_CLIP_PAD_S", "2.0"))
DATA_DIR = os.getenv("DATA_DIR", "/data")


def _clip_window(rule_id: str, t_start_s: float, t_end_s: float, metadata: dict) -> tuple[float, float]:
    """Per-rule (clip_start_s, duration_s) for VLM extraction.

    Sending the provider a tight clip centred on the diagnostic moment beats the
    full incident span. A 45 s clip of mostly-normal traffic with the impact
    buried inside is harder to read than 8 s framed on the contact frame.
    """
    if rule_id == "vehicle_collision":
        # Centre on iou_peak_t (actual contact frame). Fall back to t_start_s
        # for older rows that don't have it stored in metadata.
        peak = metadata.get("iou_peak_t")
        center = float(peak) if peak is not None else float(t_start_s)
        return max(0.0, center - 2.0), 8.0
    if rule_id == "ped_impact":
        return max(0.0, t_start_s - 2.0), 8.0
    if rule_id == "stationary_vehicle":
        return max(0.0, t_start_s), 8.0
    if rule_id == "mass_stop":
        return max(0.0, t_start_s - 1.0), 5.0
    # Unknown rule: legacy full-span fallback so the worker degrades safely.
    return max(0.0, t_start_s - CLIP_PAD_S), (t_end_s - t_start_s) + CLIP_PAD_S * 2


async def _extract_clip(video_path: Path, clip_path: Path, t_start: float, duration: float) -> None:
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(max(0.0, t_start)),
        "-i", str(video_path),
        "-t", str(max(1.0, duration)),
        "-c:v", "libx264", "-preset", "fast", "-crf", "28",
        "-an",
        str(clip_path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exit {proc.returncode}")


async def _write_result(
    pool,
    incident_id: str,
    status: str,
    verdict: str | None,
    reasoning: str | None,
    confidence: float | None,
    model: str | None,
    clip_path: str | None,
    latency_ms: int | None,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE incidents
            SET vlm_status=$2, vlm_verdict=$3, vlm_reasoning=$4,
                vlm_confidence=$5, vlm_model=$6, vlm_clip_path=$7,
                vlm_latency_ms=$8, vlm_at=now()
            WHERE id=$1
            """,
            incident_id, status, verdict, reasoning,
            confidence, model, clip_path, latency_ms,
        )


async def run_vlm_validation(video_id: str, pool) -> int:
    """Validate pending incidents for one video_id.

    Returns number of incidents processed.
    If VLM_ENABLED is false, marks all pending incidents 'skipped'.
    """
    log.info("vlm_validator.run.start", extra={"video_id": video_id, "vlm_enabled": VLM_ENABLED})
    rows = await pool.fetch(
        "SELECT id, rule_id, t_start_s, t_end_s, metadata FROM incidents "
        "WHERE video_id=$1 AND vlm_status='pending'",
        video_id,
    )
    if not rows:
        log.info("vlm_validator.run.empty", extra={"video_id": video_id})
        return 0

    if not VLM_ENABLED:
        await pool.execute(
            "UPDATE incidents SET vlm_status='skipped', vlm_at=now() "
            "WHERE video_id=$1 AND vlm_status='pending'",
            video_id,
        )
        log.info("vlm_validator.run.skipped", extra={"video_id": video_id, "incident_count": len(rows)})
        return len(rows)

    upload_row = await pool.fetchrow(
        "SELECT original_filename FROM uploads WHERE video_id=$1", video_id
    )
    if not upload_row:
        log.error("vlm_validator.upload.not_found", extra={"video_id": video_id})
        return 0

    video_dir = Path(DATA_DIR) / "videos"
    ext = Path(upload_row["original_filename"]).suffix.lower()
    video_path = video_dir / f"{video_id}{ext}"
    if not video_path.exists():
        matches = list(video_dir.glob(f"{video_id}.*"))
        if not matches:
            log.error("vlm_validator.video_file.not_found", extra={"video_id": video_id})
            return 0
        video_path = matches[0]

    clips_dir = Path(DATA_DIR) / "incidents"
    clips_dir.mkdir(parents=True, exist_ok=True)

    # Instantiate provider once for this batch — validates env at construction.
    from app.vlm_providers import get_provider
    provider = get_provider()

    count = 0
    for row in rows:
        inc_id = str(row["id"])
        rule_id = row["rule_id"]
        metadata = row["metadata"]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        t_start, duration = _clip_window(rule_id, row["t_start_s"], row["t_end_s"], metadata or {})
        clip_path = clips_dir / f"{inc_id}.mp4"

        try:
            await _extract_clip(video_path, clip_path, t_start, duration)
        except Exception as e:
            log.exception("vlm_validator.clip.extract_failed", extra={"video_id": video_id, "incident_id": inc_id})
            await _write_result(pool, inc_id, "error", None,
                                f"clip extraction failed: {e}", None, None, None, None)
            continue

        try:
            t0 = time.monotonic()
            verdict, reasoning, confidence = await provider.validate(clip_path, rule_id)
            latency_ms = int((time.monotonic() - t0) * 1000)
            await _write_result(
                pool, inc_id, "done", verdict, reasoning, confidence,
                provider.model_id, str(clip_path), latency_ms,
            )
            log.info(
                "vlm_validator.incident.complete",
                extra={
                    "video_id": video_id,
                    "incident_id": inc_id,
                    "verdict": verdict,
                    "confidence": confidence,
                    "duration_ms": latency_ms,
                },
            )
            count += 1
        except Exception as e:
            log.exception("vlm_validator.provider.call_failed", extra={"video_id": video_id, "incident_id": inc_id})
            await _write_result(pool, inc_id, "error", None,
                                f"provider call failed: {e}", None, None, str(clip_path), None)

    log.info("vlm_validator.run.complete", extra={"video_id": video_id, "incident_count": count})
    return count
