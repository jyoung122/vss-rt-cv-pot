import asyncio
import unittest

from backend.app.incident_worker import (
    ThresholdConfig,
    _build_track_signals,
    _detect_incidents,
    _merge_overlapping,
    _refresh_incidents,
)
from tools.synthetic_mdx_publisher import _collision_geometry


def _collision_rows(duration=20.0, fps=30.0, width=1920, height=1080):
    t_impact, car_a, car_b = _collision_geometry(duration, width, height)
    rows = []
    for frame_id in range(int(duration * fps)):
        t = frame_id / fps
        for car in (car_a, car_b):
            cx, cy = car.position_at(t_impact, t)
            x1, y1, x2, y2 = car.bbox(cx, cy)
            rows.append({
                "track_id": car.track_id,
                "frame_id": frame_id,
                "t_seconds": t,
                "class": "Car",
                "confidence": 0.9,
                "bbox_x1": x1,
                "bbox_y1": y1,
                "bbox_x2": x2,
                "bbox_y2": y2,
            })
    return rows


class FakeConn:
    def __init__(self):
        self.incidents = [{"video_id": "stale"}]
        self.deleted_video_ids = []

    async def execute(self, sql, *args):
        if sql.strip().startswith("DELETE FROM incidents"):
            self.deleted_video_ids.append(args[0])
            self.incidents = [inc for inc in self.incidents if inc["video_id"] != args[0]]
            return "DELETE 1"
        if sql.strip().startswith("INSERT INTO incidents"):
            self.incidents.append({"video_id": args[0], "rule_id": args[1]})
            return "INSERT 0 1"
        raise AssertionError(f"unexpected SQL: {sql}")

    async def fetchval(self, sql, *args):
        return sum(1 for inc in self.incidents if inc["video_id"] == args[0])


class IncidentWorkerTests(unittest.TestCase):
    def test_default_synthetic_collision_produces_vehicle_collision(self):
        incidents = _detect_incidents(_collision_rows(), fps=30.0, cfg=ThresholdConfig())
        collisions = [inc for inc in incidents if inc["rule_id"] == "vehicle_collision"]

        self.assertEqual(1, len(collisions))
        self.assertEqual([1, 2], collisions[0]["track_ids"])
        self.assertGreaterEqual(collisions[0]["metadata"]["iou_peak"], 0.3)

    def test_same_track_id_different_classes_are_split(self):
        rows = [
            {
                "track_id": 7,
                "frame_id": 0,
                "t_seconds": 0.0,
                "class": "Car",
                "confidence": 0.9,
                "bbox_x1": 0.0,
                "bbox_y1": 0.0,
                "bbox_x2": 100.0,
                "bbox_y2": 50.0,
            },
            {
                "track_id": 7,
                "frame_id": 0,
                "t_seconds": 0.0,
                "class": "Person",
                "confidence": 0.9,
                "bbox_x1": 200.0,
                "bbox_y1": 0.0,
                "bbox_x2": 240.0,
                "bbox_y2": 120.0,
            },
        ]

        tracks = _build_track_signals(rows, fps=30.0)

        self.assertEqual(2, len(tracks))
        self.assertEqual({"car", "person"}, {ts.cls for ts in tracks})

    def test_collision_signal_has_velocity_drop_and_stationary_tail(self):
        tracks = _build_track_signals(_collision_rows(), fps=30.0)
        car_tracks = sorted(tracks, key=lambda ts: ts.track_id)

        for track in car_tracks:
            self.assertGreaterEqual(max(track.velocity_drop), 5.0)
            self.assertGreaterEqual(max(track.stationary_run_s), 3.0)

    def test_refresh_removes_stale_incidents_when_none_found(self):
        conn = FakeConn()

        count = asyncio.run(_refresh_incidents(conn, "stale", []))

        self.assertEqual(0, count)
        self.assertEqual(["stale"], conn.deleted_video_ids)
        self.assertEqual([], conn.incidents)

    def test_merge_overlapping_collapses_brake_wave_to_densest(self):
        # Synthetic mass_stop firings mimicking the live A100 run at t≈53s:
        # the same physical brake wave fires four times as the sliding window
        # picks up different track sets. Densest = (5 tracks, 2.0s span) wins.
        firings = [
            self._mass_stop(t_start=52.13, t_end=54.00, tracks=[2, 3, 24, 26]),
            self._mass_stop(t_start=52.80, t_end=54.13, tracks=[2, 3, 4, 24, 26]),
            self._mass_stop(t_start=53.20, t_end=55.20, tracks=[2, 3, 4, 19, 26]),
            self._mass_stop(t_start=53.73, t_end=55.20, tracks=[2, 3, 4, 19]),
        ]
        merged = _merge_overlapping(firings)
        self.assertEqual(1, len(merged))
        self.assertEqual(sorted([2, 3, 4, 19, 26]), merged[0]["track_ids"])
        self.assertEqual(4, merged[0]["metadata"]["merged_firings"])

    def test_merge_overlapping_keeps_disjoint_clusters_separate(self):
        firings = [
            self._mass_stop(t_start=10.0, t_end=12.0, tracks=[1, 2, 3, 4]),
            self._mass_stop(t_start=10.5, t_end=12.3, tracks=[1, 2, 3, 4, 5]),
            self._mass_stop(t_start=40.0, t_end=42.0, tracks=[7, 8, 9, 10]),
        ]
        merged = _merge_overlapping(firings)
        self.assertEqual(2, len(merged))
        merged.sort(key=lambda r: r["t_start_s"])
        self.assertEqual([1, 2, 3, 4, 5], merged[0]["track_ids"])
        self.assertEqual(2, merged[0]["metadata"]["merged_firings"])
        self.assertEqual([7, 8, 9, 10], merged[1]["track_ids"])
        self.assertNotIn("merged_firings", merged[1]["metadata"])

    @staticmethod
    def _mass_stop(*, t_start: float, t_end: float, tracks: list[int]) -> dict:
        return {
            "rule_id": "mass_stop",
            "severity": "low",
            "confidence": 0.5,
            "t_start_s": t_start,
            "t_end_s": t_end,
            "frame_start": int(t_start * 15),
            "frame_end": int(t_end * 15),
            "track_ids": sorted(tracks),
            "bbox_union": {"x": 0, "y": 0, "w": 100, "h": 100},
            "metadata": {"track_count": len(tracks), "window_s": 2.0, "velocity_drops": {}},
        }


if __name__ == "__main__":
    unittest.main()
