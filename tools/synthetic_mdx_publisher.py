"""Synthetic mdx-raw publisher.

Publishes realistic-looking detection frames to the `mdx-raw` Redis stream so
the event indexer, scrubber, and detail page can be exercised without a GPU.

Run inside the backend container (uses its existing redis + asyncpg deps):

    docker compose -f docker-compose.dev.yml exec backend \\
        python /app/tools/synthetic_mdx_publisher.py \\
        --video-id synth-1 --ensure-upload --duration 20 --rate 200

Inside the container, redis is reachable at `redis://redis:6379` and postgres at
`postgresql://aims:aims@postgres:5432/aims` — those are the defaults below.

The object string format matches the DeepStream MDX broker:
    track_id|x1|y1|x2|y2|class|#|||||||confidence   (13 pipe parts)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import time
from dataclasses import dataclass


CLASSES = ["Car", "Person", "Bicycle"]

# ---------------------------------------------------------------------------
# Collision scenario
# ---------------------------------------------------------------------------
# Two cars approach each other, collide with sustained bbox overlap, then remain
# stationary in the overlapped pose. Starting positions are computed from the
# requested duration so the default 20s clip exercises vehicle_collision.

_COL_APPROACH_VX = 24.0      # px/s for each car before impact
_COL_IMPACT_AT = 0.45        # fraction of clip duration, capped by static tail
_COL_IMPACT_GAP_PX = 72.0    # centre gap at impact; IOU is safely above 0.3
_COL_STATIC_S = 4.0          # minimum post-impact stationary tail
_COL_MIN_APPROACH_S = 2.0    # enough motion to establish pre-impact velocity


@dataclass
class CollisionCar:
    track_id: int
    # initial centre-x, centre-y, half-w, half-h
    cx: float
    cy: float
    hw: float
    hh: float
    # signed closing velocity (positive = moving right)
    vx: float

    def position_at(self, t_impact: float, t: float) -> tuple[float, float]:
        """Return (cx, cy) at time t.  Cars stop at impact and stay overlapping."""
        if t < t_impact:
            return self.cx + self.vx * t, self.cy
        # During and after impact the car sits at its impact position
        return self.cx + self.vx * t_impact, self.cy

    def bbox(self, cx: float, cy: float) -> tuple[float, float, float, float]:
        return cx - self.hw, cy - self.hh, cx + self.hw, cy + self.hh


def _collision_geometry(
    duration: float,
    width: int,
    height: int,
) -> tuple[float, CollisionCar, CollisionCar]:
    if duration < _COL_MIN_APPROACH_S + _COL_STATIC_S:
        raise ValueError(
            "duration is too short: need at least "
            f"{_COL_MIN_APPROACH_S + _COL_STATIC_S:.1f}s for approach + stationary tail"
        )

    t_impact = min(duration * _COL_IMPACT_AT, duration - _COL_STATIC_S)
    cy = height / 2.0
    hw, hh = 80.0, 50.0
    center_x = width / 2.0
    impact_a_x = center_x - (_COL_IMPACT_GAP_PX / 2.0)
    impact_b_x = center_x + (_COL_IMPACT_GAP_PX / 2.0)
    car_a_start_x = impact_a_x - (_COL_APPROACH_VX * t_impact)
    car_b_start_x = impact_b_x + (_COL_APPROACH_VX * t_impact)

    if car_a_start_x - hw < 0 or car_b_start_x + hw > width:
        raise ValueError("frame is too narrow for the requested duration/velocity geometry")

    return (
        t_impact,
        CollisionCar(track_id=1, cx=car_a_start_x, cy=cy, hw=hw, hh=hh, vx=_COL_APPROACH_VX),
        CollisionCar(track_id=2, cx=car_b_start_x, cy=cy, hw=hw, hh=hh, vx=-_COL_APPROACH_VX),
    )


@dataclass
class Track:
    track_id: int
    cls: str
    x: float
    y: float
    w: float
    h: float
    vx: float
    vy: float
    life: int  # frames remaining

    def step(self) -> None:
        self.x += self.vx
        self.y += self.vy
        self.life -= 1

    def bbox(self, frame_w: int, frame_h: int) -> tuple[float, float, float, float]:
        x1 = max(0.0, min(self.x, frame_w - self.w))
        y1 = max(0.0, min(self.y, frame_h - self.h))
        return (x1, y1, x1 + self.w, y1 + self.h)


def _spawn(track_id: int, frame_w: int, frame_h: int) -> Track:
    cls = random.choice(CLASSES)
    if cls == "Person":
        w, h = random.uniform(40, 80), random.uniform(120, 200)
    elif cls == "Bicycle":
        w, h = random.uniform(80, 140), random.uniform(80, 140)
    else:  # Car
        w, h = random.uniform(120, 240), random.uniform(80, 160)
    return Track(
        track_id=track_id,
        cls=cls,
        x=random.uniform(0, frame_w - w),
        y=random.uniform(0, frame_h - h),
        w=w,
        h=h,
        vx=random.uniform(-6, 6),
        vy=random.uniform(-2, 2),
        life=random.randint(30, 240),
    )


def _format_object(t: Track, frame_w: int, frame_h: int) -> str:
    x1, y1, x2, y2 = t.bbox(frame_w, frame_h)
    conf = round(random.uniform(0.55, 0.95), 3)
    # 13 parts: id|x1|y1|x2|y2|class|#|||||||confidence
    return f"{t.track_id}|{x1:.1f}|{y1:.1f}|{x2:.1f}|{y2:.1f}|{t.cls}|#|||||||{conf}"


async def _ensure_upload(pg_url: str, video_id: str, duration: float, fps: float,
                         width: int, height: int) -> None:
    import asyncpg

    conn = await asyncpg.connect(pg_url)
    try:
        await conn.execute(
            """
            INSERT INTO uploads
                (video_id, original_filename, prompt, duration_s, width, height,
                 fps, size_bytes, uploaded_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (video_id) DO NOTHING
            """,
            video_id, f"{video_id}.synthetic.mp4", "synthetic publisher",
            duration, width, height, fps, 0,
        )
    finally:
        await conn.close()


async def _run_collision_scenario(args: argparse.Namespace) -> None:
    """Script two cars approaching, overlapping, and stopping — validates vehicle_collision rule."""
    import redis.asyncio as aioredis

    fps = args.fps
    total_frames = int(args.duration * fps)

    try:
        t_impact, car_a, car_b = _collision_geometry(args.duration, args.width, args.height)
    except ValueError as exc:
        raise SystemExit(
            f"[collision] {exc}"
        ) from exc
    frame_impact = int(t_impact * fps)

    r = aioredis.from_url(args.redis_url, decode_responses=True)
    await r.set("current_video_id", args.video_id)
    print(f"[ok] current_video_id = {args.video_id}")
    print(
        f"[collision] impact at t={t_impact:.1f}s (frame {frame_impact}), "
        f"impact_gap={_COL_IMPACT_GAP_PX:.0f}px, stationary_tail={args.duration - t_impact:.1f}s"
    )

    t0 = time.monotonic()
    for frame_id in range(total_frames):
        t = frame_id / fps
        objects = []

        for car in (car_a, car_b):
            cx, cy_ = car.position_at(t_impact, t)
            x1, y1, x2, y2 = car.bbox(cx, cy_)
            # Clamp to frame
            x1, y1 = max(0.0, x1), max(0.0, y1)
            x2 = min(float(args.width), x2)
            y2 = min(float(args.height), y2)
            conf = round(random.uniform(0.80, 0.95), 3)
            objects.append(
                f"{car.track_id}|{x1:.1f}|{y1:.1f}|{x2:.1f}|{y2:.1f}|Car|#|||||||{conf}"
            )

        meta = {
            "id": frame_id,
            "@timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "sensorId": args.sensor_id,
            "objects": objects,
        }
        await r.xadd("mdx-raw", {"metadata": json.dumps(meta)})

        rate = args.rate or fps
        if frame_id % max(1, int(rate)) == 0:
            phase = "approach" if t < t_impact else "stationary-overlap"
            print(f"  frame {frame_id}/{total_frames}  t={t:.2f}s  phase={phase}")

        target = t0 + (frame_id + 1) / (args.rate or fps)
        sleep = target - time.monotonic()
        if sleep > 0:
            await asyncio.sleep(sleep)

    await r.aclose()
    print(f"[done] collision scenario: {total_frames} frames in {time.monotonic()-t0:.1f}s")


async def run(args: argparse.Namespace) -> None:
    if args.ensure_upload:
        await _ensure_upload(args.pg_url, args.video_id, args.duration, args.fps,
                             args.width, args.height)
        print(f"[ok] ensured uploads row for {args.video_id}")

    if args.scenario == "collision":
        await _run_collision_scenario(args)
        return

    import redis.asyncio as aioredis

    r = aioredis.from_url(args.redis_url, decode_responses=True)
    await r.set("current_video_id", args.video_id)
    print(f"[ok] current_video_id = {args.video_id}")

    rate = args.rate or args.fps
    interval = 1.0 / rate
    total_frames = int(args.duration * args.fps)

    tracks: list[Track] = []
    next_track_id = 1
    t0 = time.monotonic()

    for frame_id in range(total_frames):
        tracks = [t for t in tracks if t.life > 0]
        while len(tracks) < args.max_tracks and random.random() < 0.3:
            tracks.append(_spawn(next_track_id, args.width, args.height))
            next_track_id += 1
        for t in tracks:
            t.step()

        objects = [_format_object(t, args.width, args.height) for t in tracks]
        meta = {
            "id": frame_id,
            "@timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "sensorId": args.sensor_id,
            "objects": objects,
        }
        await r.xadd("mdx-raw", {"metadata": json.dumps(meta)})

        if frame_id % max(1, int(rate)) == 0:
            print(f"  frame {frame_id}/{total_frames}  tracks={len(tracks)}")

        target = t0 + (frame_id + 1) * interval
        sleep = target - time.monotonic()
        if sleep > 0:
            await asyncio.sleep(sleep)

    await r.aclose()
    print(f"[done] published {total_frames} frames in {time.monotonic()-t0:.1f}s")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--video-id", required=True)
    p.add_argument("--redis-url",
                   default=os.environ.get("REDIS_URL", "redis://redis:6379"))
    p.add_argument("--pg-url",
                   default=os.environ.get("DATABASE_URL",
                                          "postgresql://aims:aims@postgres:5432/aims"))
    p.add_argument("--duration", type=float, default=20.0, help="seconds of video to simulate")
    p.add_argument("--fps", type=float, default=30.0, help="source fps (drives frame_id math)")
    p.add_argument("--rate", type=float, default=None,
                   help="publish rate (frames/sec). Default = fps (realtime). "
                        "Set higher (e.g. 200) to backfill fast.")
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--max-tracks", type=int, default=6)
    p.add_argument("--sensor-id", default="synthetic-0")
    p.add_argument("--ensure-upload", action="store_true",
                   help="INSERT an uploads row first (uses DATABASE_URL or --pg-url)")
    p.add_argument("--scenario", choices=["collision"], default=None,
                   help="Run a scripted scenario instead of random traffic. "
                        "'collision': two cars approach, overlap bboxes, then stop — "
                        "validates the vehicle_collision rule without GPU time.")
    args = p.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
