#!/usr/bin/env python3
"""Generate one simple Loki dashboard per AIMS service label."""

from __future__ import annotations

import json
from pathlib import Path


SERVICES = [
    ("aims-backend", "AIMS Backend"),
    ("aims-frontend", "AIMS Frontend"),
    ("backend", "Backend Container"),
    ("frontend", "Frontend Container"),
    ("vss-rt-cv", "DeepStream vss-rt-cv"),
    ("redis", "Redis"),
    ("postgres", "Postgres"),
    ("cosmos", "Cosmos VLM"),
    ("nvstreamer", "NVStreamer"),
    ("sdr", "SDR"),
    ("loki", "Loki"),
    ("promtail", "Promtail"),
    ("grafana", "Grafana"),
]

OUT_DIR = Path(__file__).resolve().parent / "dashboards"


def dashboard(service: str, title: str) -> dict:
    uid = "aims-service-" + service.replace("_", "-").replace(".", "-")
    return {
        "annotations": {"list": []},
        "editable": True,
        "fiscalYearStartMonth": 0,
        "graphTooltip": 0,
        "id": None,
        "links": [],
        "panels": [
            {
                "datasource": {"type": "loki", "uid": "Loki"},
                "fieldConfig": {"defaults": {}, "overrides": []},
                "gridPos": {"h": 6, "w": 24, "x": 0, "y": 0},
                "id": 1,
                "options": {
                    "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                    "tooltip": {"mode": "single", "sort": "none"},
                },
                "targets": [
                    {
                        "datasource": {"type": "loki", "uid": "Loki"},
                        "expr": f'sum by (level) (count_over_time({{service="{service}"}}[5m]))',
                        "queryType": "range",
                        "refId": "A",
                    }
                ],
                "title": "Log volume by level",
                "type": "timeseries",
            },
            {
                "datasource": {"type": "loki", "uid": "Loki"},
                "gridPos": {"h": 18, "w": 24, "x": 0, "y": 6},
                "id": 2,
                "options": {
                    "dedupStrategy": "none",
                    "enableLogDetails": True,
                    "prettifyLogMessage": False,
                    "showCommonLabels": False,
                    "showLabels": True,
                    "showTime": True,
                    "sortOrder": "Descending",
                    "wrapLogMessage": True,
                },
                "targets": [
                    {
                        "datasource": {"type": "loki", "uid": "Loki"},
                        "expr": f'{{service="{service}"}}',
                        "queryType": "range",
                        "refId": "A",
                    }
                ],
                "title": f"{title} logs",
                "type": "logs",
            },
        ],
        "refresh": "10s",
        "schemaVersion": 39,
        "tags": ["aims", "logs", "service"],
        "templating": {"list": []},
        "time": {"from": "now-1h", "to": "now"},
        "timepicker": {},
        "timezone": "",
        "title": f"AIMS Service Logs - {title}",
        "uid": uid,
        "version": 1,
        "weekStart": "",
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for service, title in SERVICES:
        path = OUT_DIR / f"aims-service-{service}.json"
        path.write_text(json.dumps(dashboard(service, title), indent=2) + "\n")


if __name__ == "__main__":
    main()
