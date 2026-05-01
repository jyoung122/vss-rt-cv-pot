"""Shared stdout logging for AIMS support/dev diagnostics."""

from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import os
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_run_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("run_id", default=None)
_video_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("video_id", default=None)

SERVICE_NAME = os.getenv("SERVICE_NAME", "aims-backend")
ENV = os.getenv("ENV", "dev")

_STANDARD_ATTRS = set(logging.makeLogRecord({}).__dict__)


def new_request_id() -> str:
    return f"req-{uuid.uuid4().hex[:12]}"


def new_run_id() -> str:
    return f"run-{uuid.uuid4().hex[:8]}"


def set_request_id(value: str | None):
    return _request_id.set(value)


def reset_request_id(token) -> None:
    _request_id.reset(token)


@contextlib.contextmanager
def log_context(
    *,
    request_id: str | None = None,
    run_id: str | None = None,
    video_id: str | None = None,
) -> Iterator[None]:
    tokens = []
    if request_id is not None:
        tokens.append((_request_id, _request_id.set(request_id)))
    if run_id is not None:
        tokens.append((_run_id, _run_id.set(run_id)))
    if video_id is not None:
        tokens.append((_video_id, _video_id.set(video_id)))
    try:
        yield
    finally:
        for var, token in reversed(tokens):
            var.reset(token)


def current_context() -> dict[str, str]:
    ctx = {
        "request_id": _request_id.get(),
        "run_id": _run_id.get(),
        "video_id": _video_id.get(),
    }
    return {key: value for key, value in ctx.items() if value}


def _iso_ts(record: logging.LogRecord) -> str:
    return datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _record_extra(record: logging.LogRecord) -> dict[str, Any]:
    extra = {}
    for key, value in record.__dict__.items():
        if key in _STANDARD_ATTRS or key.startswith("_"):
            continue
        extra[key] = value
    return extra


class AimsJsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = _iso_ts(record)
        message = record.getMessage()
        level = record.levelname.lower()
        payload: dict[str, Any] = {
            "ts": ts,
            "timestamp": ts,
            "level": level,
            "severity_text": record.levelname,
            "service": SERVICE_NAME,
            "service.name": SERVICE_NAME,
            "env": ENV,
            "logger": record.name,
            "logger.name": record.name,
            "msg": message,
            "body": message,
        }
        payload.update(current_context())
        payload.update(_record_extra(record))
        if record.exc_info:
            payload["exc_info"] = "".join(traceback.format_exception(*record.exc_info)).rstrip()
        return json.dumps(payload, default=str, separators=(",", ":"))


class AimsTextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = _iso_ts(record)
        pieces = [
            ts,
            record.levelname.lower(),
            f"service={SERVICE_NAME}",
            f"logger={record.name}",
            f"msg={record.getMessage()}",
        ]
        fields = {}
        fields.update(current_context())
        fields.update(_record_extra(record))
        for key, value in fields.items():
            pieces.append(f"{key}={value}")
        if record.exc_info:
            pieces.append("exc_info=" + self.formatException(record.exc_info).replace("\n", "\\n"))
        return " ".join(pieces)


def configure_logging() -> None:
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    log_format = os.getenv("LOG_FORMAT", "text").lower()
    formatter: logging.Formatter
    if log_format == "json":
        formatter = AimsJsonFormatter()
    else:
        formatter = AimsTextFormatter()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class Timer:
    def __init__(self) -> None:
        self._start = time.monotonic()

    @property
    def duration_ms(self) -> int:
        return int((time.monotonic() - self._start) * 1000)
