"""VLM validation worker — Cosmos-Reason2-2B per-incident confirmation.

Picks up incidents with vlm_status='pending', extracts a clip via ffmpeg,
calls the Cosmos NIM container, parses the verdict, and writes back.

VLM_ENABLED=false (default) → marks all pending incidents 'skipped'.
"""

import asyncio
import base64
import json
import logging
import os
import re
import time
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

VLM_ENABLED = os.getenv("VLM_ENABLED", "false").lower() == "true"
COSMOS_URL = os.getenv("COSMOS_URL", "http://cosmos:8000")
CLIP_PAD_S = float(os.getenv("VLM_CLIP_PAD_S", "2.0"))
VLM_TIMEOUT_S = float(os.getenv("VLM_TIMEOUT_S", "120.0"))
DATA_DIR = os.getenv("DATA_DIR", "/data")

_PROMPTS: dict[str, str] = {
    "vehicle_collision": (
        "You are analyzing a traffic camera clip for a suspected vehicle collision. "
        "Look carefully at the vehicles. Does a collision or significant impact occur? "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
    "ped_impact": (
        "You are analyzing a traffic camera clip for a suspected pedestrian impact. "
        "Look for contact or dangerous near-miss between a vehicle and a person. "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
    "stationary_vehicle": (
        "You are analyzing a traffic camera clip for a vehicle stopped in an unusual position. "
        "Is a vehicle blocking a lane, stopped on a shoulder, or parked where it should not be? "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
    "mass_stop": (
        "You are analyzing a traffic camera clip for a sudden mass traffic stop. "
        "Do multiple vehicles brake abruptly or come to an unusual simultaneous stop? "
        'Respond ONLY with JSON: {"verdict": "confirmed"|"rejected"|"uncertain", '
        '"confidence": 0.0-1.0, "reasoning": "one concise sentence"}'
    ),
}


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


def _parse_verdict(content: str) -> tuple[str, float, str]:
    """Extract verdict/confidence/reasoning from model response, stripping <think> blocks."""
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
    match = re.search(r"\{[^{}]*\"verdict\"[^{}]*\}", content, re.DOTALL)
    if not match:
        return "uncertain", 0.5, content[:300]
    try:
        data = json.loads(match.group())
        verdict = data.get("verdict", "uncertain")
        if verdict not in ("confirmed", "rejected", "uncertain"):
            verdict = "uncertain"
        confidence = float(data.get("confidence", 0.5))
        confidence = max(0.0, min(1.0, confidence))
        reasoning = str(data.get("reasoning", ""))[:500]
        return verdict, confidence, reasoning
    except Exception:
        return "uncertain", 0.5, content[:300]


async def _call_cosmos(clip_path: Path, rule_id: str) -> tuple[str, str, float]:
    """Send clip to Cosmos NIM. Returns (verdict, reasoning, confidence)."""
    prompt = _PROMPTS.get(rule_id, _PROMPTS["vehicle_collision"])
    b64 = base64.b64encode(clip_path.read_bytes()).decode()
    payload = {
        "model": "nvidia/cosmos-reason2-2b",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "max_tokens": 512,
        "temperature": 0.1,
    }
    async with httpx.AsyncClient(timeout=VLM_TIMEOUT_S) as client:
        resp = await client.post(f"{COSMOS_URL}/v1/chat/completions", json=payload)
        resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    verdict, confidence, reasoning = _parse_verdict(content)
    return verdict, reasoning, confidence


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
    rows = await pool.fetch(
        "SELECT id, rule_id, t_start_s, t_end_s FROM incidents "
        "WHERE video_id=$1 AND vlm_status='pending'",
        video_id,
    )
    if not rows:
        return 0

    if not VLM_ENABLED:
        await pool.execute(
            "UPDATE incidents SET vlm_status='skipped', vlm_at=now() "
            "WHERE video_id=$1 AND vlm_status='pending'",
            video_id,
        )
        log.info("vlm_validator: VLM disabled — skipped %d incidents for %s", len(rows), video_id)
        return len(rows)

    upload_row = await pool.fetchrow(
        "SELECT original_filename FROM uploads WHERE video_id=$1", video_id
    )
    if not upload_row:
        return 0

    video_dir = Path(DATA_DIR) / "videos"
    ext = Path(upload_row["original_filename"]).suffix.lower()
    video_path = video_dir / f"{video_id}{ext}"
    if not video_path.exists():
        matches = list(video_dir.glob(f"{video_id}.*"))
        if not matches:
            log.error("vlm_validator: video file not found for %s", video_id)
            return 0
        video_path = matches[0]

    clips_dir = Path(DATA_DIR) / "incidents"
    clips_dir.mkdir(parents=True, exist_ok=True)

    count = 0
    for row in rows:
        inc_id = str(row["id"])
        rule_id = row["rule_id"]
        t_start = max(0.0, row["t_start_s"] - CLIP_PAD_S)
        duration = (row["t_end_s"] - row["t_start_s"]) + CLIP_PAD_S * 2
        clip_path = clips_dir / f"{inc_id}.mp4"

        try:
            await _extract_clip(video_path, clip_path, t_start, duration)
        except Exception as e:
            log.error("vlm_validator: clip extraction failed for %s: %s", inc_id, e)
            await _write_result(pool, inc_id, "error", None,
                                f"clip extraction failed: {e}", None, None, None, None)
            continue

        try:
            t0 = time.monotonic()
            verdict, reasoning, confidence = await _call_cosmos(clip_path, rule_id)
            latency_ms = int((time.monotonic() - t0) * 1000)
            await _write_result(
                pool, inc_id, "done", verdict, reasoning, confidence,
                "nvidia/cosmos-reason2-2b", str(clip_path), latency_ms,
            )
            log.info("vlm_validator: %s → %s (%.2f) in %dms", inc_id, verdict, confidence, latency_ms)
            count += 1
        except Exception as e:
            log.error("vlm_validator: cosmos call failed for %s: %s", inc_id, e)
            await _write_result(pool, inc_id, "error", None,
                                f"cosmos call failed: {e}", None, None, str(clip_path), None)

    return count
