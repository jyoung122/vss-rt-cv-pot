"""Rule-based incident detection worker.

Reads events for a completed video, applies pixel-space heuristics over
per-track and pairwise signals, and upserts results into the incidents table.

Thresholds are stored in the rule_config DB table and loaded at analysis time
(see load_thresholds / DEFAULT_THRESHOLDS). The module-level constants below
serve as compile-time defaults only — they are never read at runtime.

Auto-trigger from event_indexer end-of-stream is not wired: the indexer has no
clean EOS hook (it's a continuous XREADGROUP loop). Use POST /api/uploads/:id/analyze
to trigger explicitly after ingestion completes.
"""

import json
import logging
import math
import time
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default thresholds — used when no DB override exists.
# Keys match the JSONB stored in rule_config.thresholds.
# ---------------------------------------------------------------------------

DEFAULT_THRESHOLDS: dict[str, dict[str, Any]] = {
    "vehicle_collision": {
        "iou_min": 0.3,
        "iou_frames_min": 3,
        "costop_window_s": 1.0,
        "stationary_after_s": 3.0,
        "velocity_drop_min": 5.0,
    },
    "ped_impact": {
        "proximity_max": 0.5,
        "proximity_frames_min": 2,
    },
    "stationary_vehicle": {
        "min_s": 15.0,
        "moved_px_s": 8.0,
    },
    "mass_stop": {
        "tracks_min": 4,
        "window_s": 2.0,
        "drop_min": 6.0,
    },
}

# Threshold metadata for the configuration UI (label, units, type, min/max/step).
THRESHOLD_SCHEMA: dict[str, list[dict[str, Any]]] = {
    "vehicle_collision": [
        {"key": "iou_min",             "label": "Min IOU overlap",          "unit": "",     "type": "float", "min": 0.05, "max": 0.95, "step": 0.05},
        {"key": "iou_frames_min",      "label": "Sustained overlap frames",  "unit": "frames","type": "int",   "min": 1,    "max": 20,   "step": 1},
        {"key": "costop_window_s",     "label": "Co-stop window",           "unit": "s",    "type": "float", "min": 0.5,  "max": 5.0,  "step": 0.5},
        {"key": "stationary_after_s",  "label": "Stationary after (combined)","unit": "s",  "type": "float", "min": 1.0,  "max": 30.0, "step": 0.5},
        {"key": "velocity_drop_min",   "label": "Velocity drop ratio",      "unit": "×",    "type": "float", "min": 1.5,  "max": 20.0, "step": 0.5},
    ],
    "ped_impact": [
        {"key": "proximity_max",        "label": "Centroid proximity",       "unit": "× diag","type": "float", "min": 0.1,  "max": 2.0,  "step": 0.1},
        {"key": "proximity_frames_min", "label": "Sustained proximity frames","unit": "frames","type": "int",   "min": 1,    "max": 10,   "step": 1},
    ],
    "stationary_vehicle": [
        {"key": "min_s",       "label": "Min stationary duration", "unit": "s",    "type": "float", "min": 5.0,  "max": 120.0, "step": 5.0},
        {"key": "moved_px_s",  "label": "Min prior velocity",      "unit": "px/s", "type": "float", "min": 1.0,  "max": 50.0,  "step": 1.0},
    ],
    "mass_stop": [
        {"key": "tracks_min", "label": "Min vehicles",      "unit": "",   "type": "int",   "min": 2,   "max": 20,   "step": 1},
        {"key": "window_s",   "label": "Time window",       "unit": "s",  "type": "float", "min": 0.5, "max": 10.0, "step": 0.5},
        {"key": "drop_min",   "label": "Velocity drop ratio","unit": "×", "type": "float", "min": 1.5, "max": 30.0, "step": 0.5},
    ],
}

# Shared velocity-signal constants — not user-tunable for now.
_VELOCITY_WINDOW_S = 0.5
_VELOCITY_DROP_WINDOW_S = 1.0
_STATIONARY_VX_PX_S = 5.0


# ---------------------------------------------------------------------------
# Per-analysis threshold config (loaded from DB, merged with defaults)
# ---------------------------------------------------------------------------

@dataclass
class ThresholdConfig:
    # vehicle_collision
    collision_iou_min: float = 0.3
    collision_iou_frames_min: int = 3
    collision_costop_window_s: float = 1.0
    collision_stationary_after_s: float = 3.0
    collision_velocity_drop_min: float = 5.0
    # ped_impact
    ped_proximity_max: float = 0.5
    ped_proximity_frames_min: int = 2
    # stationary_vehicle
    stationary_min_s: float = 15.0
    stationary_moved_px_s: float = 8.0
    # mass_stop
    mass_stop_tracks_min: int = 4
    mass_stop_window_s: float = 2.0
    mass_stop_drop_min: float = 6.0


async def load_thresholds(pool) -> ThresholdConfig:
    """Load per-rule overrides from rule_config and merge with code defaults."""
    rows = await pool.fetch("SELECT rule_id, thresholds FROM rule_config")
    db: dict[str, dict] = {}
    for row in rows:
        raw = row["thresholds"]
        db[row["rule_id"]] = json.loads(raw) if isinstance(raw, str) else (raw or {})

    def _get(rule_id: str, key: str, default):
        return db.get(rule_id, {}).get(key, default)

    vc = db.get("vehicle_collision", {})
    pi = db.get("ped_impact", {})
    sv = db.get("stationary_vehicle", {})
    ms = db.get("mass_stop", {})
    d = DEFAULT_THRESHOLDS

    return ThresholdConfig(
        collision_iou_min=float(vc.get("iou_min",            d["vehicle_collision"]["iou_min"])),
        collision_iou_frames_min=int(vc.get("iou_frames_min",d["vehicle_collision"]["iou_frames_min"])),
        collision_costop_window_s=float(vc.get("costop_window_s", d["vehicle_collision"]["costop_window_s"])),
        collision_stationary_after_s=float(vc.get("stationary_after_s", d["vehicle_collision"]["stationary_after_s"])),
        collision_velocity_drop_min=float(vc.get("velocity_drop_min",  d["vehicle_collision"]["velocity_drop_min"])),
        ped_proximity_max=float(pi.get("proximity_max",         d["ped_impact"]["proximity_max"])),
        ped_proximity_frames_min=int(pi.get("proximity_frames_min", d["ped_impact"]["proximity_frames_min"])),
        stationary_min_s=float(sv.get("min_s",                 d["stationary_vehicle"]["min_s"])),
        stationary_moved_px_s=float(sv.get("moved_px_s",       d["stationary_vehicle"]["moved_px_s"])),
        mass_stop_tracks_min=int(ms.get("tracks_min",           d["mass_stop"]["tracks_min"])),
        mass_stop_window_s=float(ms.get("window_s",             d["mass_stop"]["window_s"])),
        mass_stop_drop_min=float(ms.get("drop_min",             d["mass_stop"]["drop_min"])),
    )


def _normalize_class(cls: str) -> str:
    return cls.strip().lower()


VEHICLE_CLASSES = {"car", "bicycle"}
CAR_CLASSES = {"car"}
PED_CLASSES = {"person"}


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class DetectionRow:
    track_id: int
    frame_id: int
    t_seconds: float
    cls: str
    bbox_x1: float
    bbox_y1: float
    bbox_x2: float
    bbox_y2: float

    @property
    def cx(self) -> float:
        return (self.bbox_x1 + self.bbox_x2) / 2

    @property
    def cy(self) -> float:
        return (self.bbox_y1 + self.bbox_y2) / 2

    @property
    def w(self) -> float:
        return self.bbox_x2 - self.bbox_x1

    @property
    def h(self) -> float:
        return self.bbox_y2 - self.bbox_y1

    @property
    def diag(self) -> float:
        return math.hypot(self.w, self.h)


@dataclass
class TrackSignals:
    track_id: int
    cls: str
    rows: list[DetectionRow] = field(default_factory=list)

    # Computed once by _compute_signals()
    velocity: list[float] = field(default_factory=list)          # px/s per row
    velocity_drop: list[float] = field(default_factory=list)     # v(t-1s)/v(t)
    stationary_run_s: list[float] = field(default_factory=list)  # consecutive stationary time at each row
    max_velocity_ever: float = 0.0                                # peak velocity (filter parked cars)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def _iou(a: DetectionRow, b: DetectionRow) -> float:
    ix1 = max(a.bbox_x1, b.bbox_x1)
    iy1 = max(a.bbox_y1, b.bbox_y1)
    ix2 = min(a.bbox_x2, b.bbox_x2)
    iy2 = min(a.bbox_y2, b.bbox_y2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = a.w * a.h
    area_b = b.w * b.h
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _bbox_union(rows: list[DetectionRow]) -> dict[str, int]:
    x1 = min(r.bbox_x1 for r in rows)
    y1 = min(r.bbox_y1 for r in rows)
    x2 = max(r.bbox_x2 for r in rows)
    y2 = max(r.bbox_y2 for r in rows)
    return {"x": int(x1), "y": int(y1), "w": int(x2 - x1), "h": int(y2 - y1)}


def _compute_signals(ts: TrackSignals, fps: float) -> None:
    rows = ts.rows
    times = [r.t_seconds for r in rows]
    velocity: list[float] = []

    half_win = _VELOCITY_WINDOW_S / 2.0

    for row in rows:
        t = row.t_seconds
        lo = bisect_left(times, t - half_win)
        hi = bisect_right(times, t + half_win)
        if hi - lo <= 1:
            velocity.append(0.0)
            continue

        first = rows[lo]
        last = rows[hi - 1]
        dt = last.t_seconds - first.t_seconds
        if dt < 1e-6:
            velocity.append(0.0)
            continue

        dcx = last.cx - first.cx
        dcy = last.cy - first.cy
        velocity.append(math.hypot(dcx, dcy) / dt)

    ts.velocity = velocity
    ts.max_velocity_ever = max(velocity) if velocity else 0.0

    # velocity_drop_ratio: v(t - _VELOCITY_DROP_WINDOW_S) / v(t)
    velocity_drop: list[float] = []
    for i, row in enumerate(rows):
        t = row.t_seconds
        v_now = velocity[i]
        t_prev = t - _VELOCITY_DROP_WINDOW_S
        pos = bisect_left(times, t_prev)
        candidates = []
        if pos < len(rows):
            candidates.append(pos)
        if pos > 0:
            candidates.append(pos - 1)

        if not candidates or v_now < 0.5:
            velocity_drop.append(0.0)
            continue

        j = min(candidates, key=lambda k: abs(rows[k].t_seconds - t_prev))
        if abs(rows[j].t_seconds - t_prev) > 0.5:
            velocity_drop.append(0.0)
            continue

        v_before = velocity[j]
        velocity_drop.append(v_before / v_now)
    ts.velocity_drop = velocity_drop

    # stationary_run_s: how long the track has been stationary up to each row
    stationary_run: list[float] = []
    run = 0.0
    for i, row in enumerate(rows):
        if velocity[i] < _STATIONARY_VX_PX_S:
            dt = (row.t_seconds - rows[i - 1].t_seconds) if i > 0 else 0.0
            run += dt
        else:
            run = 0.0
        stationary_run.append(run)
    ts.stationary_run_s = stationary_run


# ---------------------------------------------------------------------------
# Pairwise helpers
# ---------------------------------------------------------------------------

def _frames_by_time(rows: list[DetectionRow], t_min: float, t_max: float) -> list[DetectionRow]:
    return [r for r in rows if t_min <= r.t_seconds <= t_max]


def _at_time(rows: list[DetectionRow], t: float, tol: float = 0.1) -> DetectionRow | None:
    candidates = [r for r in rows if abs(r.t_seconds - t) <= tol]
    if not candidates:
        return None
    return min(candidates, key=lambda r: abs(r.t_seconds - t))


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

def _rule_vehicle_collision(
    ts_a: TrackSignals,
    ts_b: TrackSignals,
    fps: float,
    cfg: ThresholdConfig,
) -> dict[str, Any] | None:
    """Two vehicle tracks with sustained IOU overlap + simultaneous velocity collapse."""
    if _normalize_class(ts_a.cls) not in VEHICLE_CLASSES or _normalize_class(ts_b.cls) not in VEHICLE_CLASSES:
        return None

    # Find frames where both tracks are present
    t_a = {r.t_seconds: r for r in ts_a.rows}
    t_b = {r.t_seconds: r for r in ts_b.rows}
    shared_times = sorted(set(t_a) & set(t_b))
    if not shared_times:
        return None

    # Sliding scan for sustained IOU overlap
    overlap_sequences: list[list[float]] = []
    current: list[float] = []
    for t in shared_times:
        iou_val = _iou(t_a[t], t_b[t])
        if iou_val >= cfg.collision_iou_min:
            current.append(t)
        else:
            if current:
                overlap_sequences.append(current)
            current = []
    if current:
        overlap_sequences.append(current)

    valid_seqs = [seq for seq in overlap_sequences if len(seq) >= cfg.collision_iou_frames_min]
    if not valid_seqs:
        return None

    anchor_seq = max(valid_seqs, key=len)
    t_overlap_start = anchor_seq[0]
    t_overlap_end = anchor_seq[-1]

    def _has_costop(ts: TrackSignals, t_ref: float) -> tuple[bool, float]:
        window = [
            (ts.velocity_drop[i], ts.rows[i].t_seconds)
            for i in range(len(ts.rows))
            if abs(ts.rows[i].t_seconds - t_ref) <= cfg.collision_costop_window_s
        ]
        if not window:
            return False, 0.0
        peak = max(window, key=lambda x: x[0])
        return peak[0] >= cfg.collision_velocity_drop_min, peak[0]

    a_stop, a_drop = _has_costop(ts_a, t_overlap_start)
    b_stop, b_drop = _has_costop(ts_b, t_overlap_start)
    if not (a_stop and b_stop):
        return None

    def _stationary_after(ts: TrackSignals, t_ref: float) -> float:
        post = [
            ts.stationary_run_s[i]
            for i in range(len(ts.rows))
            if ts.rows[i].t_seconds >= t_ref
        ]
        return max(post) if post else 0.0

    stat_a = _stationary_after(ts_a, t_overlap_end)
    stat_b = _stationary_after(ts_b, t_overlap_end)
    if stat_a + stat_b < cfg.collision_stationary_after_s:
        return None

    iou_peak = max(_iou(t_a[t], t_b[t]) for t in anchor_seq)

    sustain_factor = min(1.0, (stat_a + stat_b) / (cfg.collision_stationary_after_s * 2))
    confidence = min(0.95, 0.7 + 0.15 * iou_peak + 0.10 * sustain_factor)

    # Time span
    t_end = max(
        ts_a.rows[-1].t_seconds if ts_a.rows else t_overlap_end,
        ts_b.rows[-1].t_seconds if ts_b.rows else t_overlap_end,
    )
    # Peak frame: frame with highest IOU
    peak_t = max(anchor_seq, key=lambda t: _iou(t_a[t], t_b[t]))
    peak_rows = [r for r in list(t_a.values()) + list(t_b.values()) if abs(r.t_seconds - peak_t) < 0.05]

    # frame range
    candidates = [r.frame_id for r in ts_a.rows + ts_b.rows if r.t_seconds >= t_overlap_start - 0.5]
    frame_start = min(candidates) if candidates else (ts_a.rows + ts_b.rows)[0].frame_id
    frame_end = max(r.frame_id for r in ts_a.rows + ts_b.rows)

    return {
        "rule_id": "vehicle_collision",
        "severity": "high",
        "confidence": round(confidence, 4),
        "t_start_s": round(t_overlap_start, 4),
        "t_end_s": round(t_end, 4),
        "frame_start": frame_start,
        "frame_end": frame_end,
        "track_ids": sorted([ts_a.track_id, ts_b.track_id]),
        "bbox_union": _bbox_union(peak_rows or list(t_a.values())[:1] + list(t_b.values())[:1]),
        "metadata": {
            "iou_peak": round(iou_peak, 4),
            "velocity_drop_a": round(a_drop, 2),
            "velocity_drop_b": round(b_drop, 2),
            "stationary_after_a_s": round(stat_a, 2),
            "stationary_after_b_s": round(stat_b, 2),
            "classes": [ts_a.cls, ts_b.cls],
        },
    }


def _rule_ped_impact(
    ts_car: TrackSignals,
    ts_ped: TrackSignals,
    cfg: ThresholdConfig,
) -> dict[str, Any] | None:
    """Car + person track with centroid proximity + person velocity collapse."""
    if _normalize_class(ts_car.cls) not in CAR_CLASSES or _normalize_class(ts_ped.cls) not in PED_CLASSES:
        return None

    t_car = {r.t_seconds: r for r in ts_car.rows}
    t_ped = {r.t_seconds: r for r in ts_ped.rows}
    shared_times = sorted(set(t_car) & set(t_ped))
    if not shared_times:
        return None

    prox_frames: list[float] = []
    for t in shared_times:
        rc = t_car[t]
        rp = t_ped[t]
        avg_diag = (rc.diag + rp.diag) / 2.0
        if avg_diag < 1.0:
            continue
        dist = math.hypot(rc.cx - rp.cx, rc.cy - rp.cy)
        prox = dist / avg_diag
        if prox < cfg.ped_proximity_max:
            prox_frames.append(t)

    if len(prox_frames) < cfg.ped_proximity_frames_min:
        return None

    t_impact = prox_frames[0]

    post_ped = [
        (ts_ped.velocity[i], ts_ped.rows[i].t_seconds)
        for i in range(len(ts_ped.rows))
        if ts_ped.rows[i].t_seconds >= t_impact and ts_ped.rows[i].t_seconds <= t_impact + 1.0
    ]
    ped_stops = any(v < _STATIONARY_VX_PX_S for v, _ in post_ped)
    ped_terminates = not any(r.t_seconds > t_impact + 1.0 for r in ts_ped.rows)

    if not (ped_stops or ped_terminates):
        return None

    candidates = [r.frame_id for r in ts_car.rows + ts_ped.rows if r.t_seconds >= t_impact - 0.2]
    frame_start = min(candidates) if candidates else (ts_car.rows + ts_ped.rows)[0].frame_id
    frame_end = max(r.frame_id for r in ts_car.rows + ts_ped.rows)
    t_end = max(
        ts_car.rows[-1].t_seconds if ts_car.rows else t_impact,
        ts_ped.rows[-1].t_seconds if ts_ped.rows else t_impact,
    )

    peak_rows = [t_car.get(prox_frames[0]), t_ped.get(prox_frames[0])]
    peak_rows = [r for r in peak_rows if r is not None]

    return {
        "rule_id": "ped_impact",
        "severity": "high",
        "confidence": 0.7,
        "t_start_s": round(t_impact, 4),
        "t_end_s": round(t_end, 4),
        "frame_start": frame_start,
        "frame_end": frame_end,
        "track_ids": sorted([ts_car.track_id, ts_ped.track_id]),
        "bbox_union": _bbox_union(peak_rows),
        "metadata": {
            "proximity_frames": len(prox_frames),
            "ped_terminates": ped_terminates,
            "ped_stops": ped_stops,
            "classes": [ts_car.cls, ts_ped.cls],
        },
    }


def _rule_stationary_vehicle(ts: TrackSignals, cfg: ThresholdConfig) -> dict[str, Any] | None:
    """Single car track that stays stationary for cfg.stationary_min_s after having moved."""
    if _normalize_class(ts.cls) not in CAR_CLASSES:
        return None

    if ts.max_velocity_ever < cfg.stationary_moved_px_s:
        return None

    max_stat = max(ts.stationary_run_s) if ts.stationary_run_s else 0.0
    if max_stat < cfg.stationary_min_s:
        return None

    # Find where the run starts
    peak_idx = ts.stationary_run_s.index(max_stat)
    run_start_idx = peak_idx
    while run_start_idx > 0 and ts.stationary_run_s[run_start_idx - 1] > 0:
        run_start_idx -= 1

    t_start = ts.rows[run_start_idx].t_seconds
    t_end = ts.rows[peak_idx].t_seconds
    frame_start = ts.rows[run_start_idx].frame_id
    frame_end = ts.rows[peak_idx].frame_id
    rows_in_run = ts.rows[run_start_idx:peak_idx + 1]

    return {
        "rule_id": "stationary_vehicle",
        "severity": "low",
        "confidence": 0.5,
        "t_start_s": round(t_start, 4),
        "t_end_s": round(t_end, 4),
        "frame_start": frame_start,
        "frame_end": frame_end,
        "track_ids": [ts.track_id],
        "bbox_union": _bbox_union(rows_in_run) if rows_in_run else _bbox_union(ts.rows[:1]),
        "metadata": {
            "stationary_duration_s": round(max_stat, 2),
            "max_velocity_ever_px_s": round(ts.max_velocity_ever, 2),
            "class": ts.cls,
        },
    }


def _rule_mass_stop(
    track_signals: list[TrackSignals],
    fps: float,
    cfg: ThresholdConfig,
) -> list[dict[str, Any]]:
    """4+ vehicle tracks with high velocity_drop_ratio within a configurable window."""
    vehicles = [ts for ts in track_signals if _normalize_class(ts.cls) in VEHICLE_CLASSES]
    if len(vehicles) < cfg.mass_stop_tracks_min:
        return []

    stop_events: list[tuple[float, int, float]] = []
    for ts in vehicles:
        for i, drop in enumerate(ts.velocity_drop):
            if drop >= cfg.mass_stop_drop_min:
                stop_events.append((ts.rows[i].t_seconds, ts.track_id, drop))

    stop_events.sort()
    if not stop_events:
        return []

    results: list[dict[str, Any]] = []
    seen_windows: set[tuple[float, frozenset[int]]] = set()

    for anchor_idx, (t_anchor, _, _) in enumerate(stop_events):
        window = [(t, tid, drop) for t, tid, drop in stop_events
                  if t_anchor <= t <= t_anchor + cfg.mass_stop_window_s]
        track_ids_in_window = {tid for _, tid, _ in window}
        if len(track_ids_in_window) < cfg.mass_stop_tracks_min:
            continue

        key = (round(t_anchor / cfg.mass_stop_window_s), frozenset(track_ids_in_window))
        if key in seen_windows:
            continue
        seen_windows.add(key)

        t_end = window[-1][0]
        involved_tracks = [ts for ts in vehicles if ts.track_id in track_ids_in_window]
        all_rows = [r for ts in involved_tracks for r in ts.rows
                    if t_anchor - 0.1 <= r.t_seconds <= t_end + 0.1]
        if not all_rows:
            continue

        results.append({
            "rule_id": "mass_stop",
            "severity": "low",
            "confidence": 0.5,
            "t_start_s": round(t_anchor, 4),
            "t_end_s": round(t_end, 4),
            "frame_start": min(r.frame_id for r in all_rows),
            "frame_end": max(r.frame_id for r in all_rows),
            "track_ids": sorted(track_ids_in_window),
            "bbox_union": _bbox_union(all_rows),
            "metadata": {
                "track_count": len(track_ids_in_window),
                "window_s": cfg.mass_stop_window_s,
                "velocity_drops": {tid: round(drop, 2) for _, tid, drop in window},
            },
        })

    return results


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def _build_track_signals(rows: list[Any], fps: float) -> list[TrackSignals]:
    tracks_map: dict[tuple[int, str], TrackSignals] = {}
    for r in rows:
        tid = r["track_id"]
        normalized_cls = _normalize_class(r["class"])
        key = (tid, normalized_cls)
        if key not in tracks_map:
            tracks_map[key] = TrackSignals(track_id=tid, cls=normalized_cls)
        tracks_map[key].rows.append(DetectionRow(
            track_id=tid,
            frame_id=r["frame_id"],
            t_seconds=r["t_seconds"],
            cls=normalized_cls,
            bbox_x1=r["bbox_x1"],
            bbox_y1=r["bbox_y1"],
            bbox_x2=r["bbox_x2"],
            bbox_y2=r["bbox_y2"],
        ))

    track_signals = list(tracks_map.values())
    for ts in track_signals:
        ts.rows.sort(key=lambda row: row.t_seconds)
        _compute_signals(ts, fps)
    return track_signals


def _detect_incidents(rows: list[Any], fps: float, cfg: ThresholdConfig) -> list[dict[str, Any]]:
    track_signals = _build_track_signals(rows, fps)

    incidents: list[dict[str, Any]] = []

    for i in range(len(track_signals)):
        for j in range(i + 1, len(track_signals)):
            ts_a, ts_b = track_signals[i], track_signals[j]

            col = _rule_vehicle_collision(ts_a, ts_b, fps, cfg)
            if col:
                incidents.append(col)

            ped = _rule_ped_impact(ts_a, ts_b, cfg)
            if ped:
                incidents.append(ped)
            ped = _rule_ped_impact(ts_b, ts_a, cfg)
            if ped:
                incidents.append(ped)

    for ts in track_signals:
        stat = _rule_stationary_vehicle(ts, cfg)
        if stat:
            incidents.append(stat)

    incidents.extend(_rule_mass_stop(track_signals, fps, cfg))

    return incidents


async def _load_detection_inputs(conn, video_id: str) -> tuple[list[Any], float]:
    rows = await conn.fetch(
        """
        SELECT track_id, frame_id, t_seconds, class, confidence,
               bbox_x1, bbox_y1, bbox_x2, bbox_y2
        FROM events
        WHERE video_id = $1
        ORDER BY track_id, t_seconds
        """,
        video_id,
    )

    fps_row = await conn.fetchrow("SELECT fps FROM uploads WHERE video_id=$1", video_id)
    fps = fps_row["fps"] if fps_row and fps_row["fps"] else 30.0
    return list(rows), fps


async def _refresh_incidents(conn, video_id: str, incidents: list[dict[str, Any]]) -> int:
    # Full replace: delete all prior rule detections then insert fresh.
    # VLM columns reset to default 'pending'; the analyze endpoint re-queues VLM.
    await conn.execute("DELETE FROM incidents WHERE video_id=$1", video_id)

    if not incidents:
        log.info("incident_worker.refresh.empty", extra={"video_id": video_id})
        return 0

    for inc in incidents:
        await conn.execute(
            """
            INSERT INTO incidents
                (video_id, rule_id, severity, confidence,
                 t_start_s, t_end_s, frame_start, frame_end,
                 track_ids, bbox_union, metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
            """,
            video_id,
            inc["rule_id"],
            inc["severity"],
            inc["confidence"],
            inc["t_start_s"],
            inc["t_end_s"],
            inc["frame_start"],
            inc["frame_end"],
            inc["track_ids"],
            json.dumps(inc["bbox_union"]),
            json.dumps(inc["metadata"]),
        )


    count = await conn.fetchval(
        "SELECT COUNT(*) FROM incidents WHERE video_id=$1",
        video_id,
    )
    log.info("incident_worker.refresh.complete", extra={"video_id": video_id, "incident_count": count})
    return count


async def run_incident_detection(video_id: str, pool) -> int:
    """Detect incidents for one video_id and replace prior rule results."""
    t0 = time.monotonic()
    cfg = await load_thresholds(pool)
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows, fps = await _load_detection_inputs(conn, video_id)
            log.info(
                "incident_worker.detect.start",
                extra={"video_id": video_id, "event_count": len(rows), "fps": fps},
            )
            incidents = _detect_incidents(rows, fps, cfg) if rows else []
            count = await _refresh_incidents(conn, video_id, incidents)
            log.info(
                "incident_worker.detect.complete",
                extra={
                    "video_id": video_id,
                    "event_count": len(rows),
                    "incident_count": count,
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                },
            )
            return count
