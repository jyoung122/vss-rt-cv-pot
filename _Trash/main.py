"""Tiny RunPod OpenAI-compatible endpoint smoke test.

Usage:
    python3 _Trash/main.py

Optional env vars:
    RUNPOD_OPENAI_API_KEY   Bearer token, if your server requires one.
    RUNPOD_OPENAI_MODEL     Model id to use. Defaults to nvidia/cosmos-reason2-2b.
    RUNPOD_OPENAI_BASE_URL  Override the RunPod proxy base URL.
    RUNPOD_OPENAI_WAIT_S    Max seconds to wait for startup. Defaults to 600.
    RUNPOD_OPENAI_RETRY_S   Seconds between retries. Defaults to 10.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any


POD_ID = "vz7sc7u9b0d1wp"
PORT = 8000
BASE_URL = os.getenv("RUNPOD_OPENAI_BASE_URL", f"https://{POD_ID}-{PORT}.proxy.runpod.net")
DEFAULT_MODEL = "nvidia/cosmos-reason2-2b"
WAIT_TIMEOUT_S = float(os.getenv("RUNPOD_OPENAI_WAIT_S", "600"))
RETRY_DELAY_S = float(os.getenv("RUNPOD_OPENAI_RETRY_S", "10"))


class EndpointError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, details: str) -> None:
        self.method = method
        self.path = path
        self.status = status
        self.details = details
        super().__init__(f"{method} {path} failed: HTTP {status}: {details}")


def _headers() -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "runpod-openai-smoke-test/1.0",
    }
    api_key = os.getenv("RUNPOD_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _request_json(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=body,
        headers=_headers(),
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise EndpointError(method, path, exc.code, details) from exc


def _request_status(path: str) -> tuple[int, str]:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        headers=_headers(),
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read(300).decode("utf-8", errors="replace")
            return response.status, body
    except urllib.error.HTTPError as exc:
        body = exc.read(300).decode("utf-8", errors="replace")
        return exc.code, body


def check_endpoint() -> None:
    print(f"Base URL: {BASE_URL}", flush=True)
    for path in ("/", "/health", "/v1/models"):
        status, body = _request_status(path)
        preview = body.replace("\n", " ")[:180]
        print(f"GET {path}: HTTP {status} {preview}", flush=True)


def list_models() -> list[str]:
    models = _request_json("GET", "/v1/models")
    data = models.get("data") or []
    return [str(model["id"]) for model in data if "id" in model]


def get_first_model() -> str:
    configured_model = os.getenv("RUNPOD_OPENAI_MODEL")
    if configured_model:
        return configured_model

    data = list_models()
    if not data:
        raise RuntimeError("No models returned from /v1/models. Set RUNPOD_OPENAI_MODEL manually.")
    return data[0]


def send_hello(model: str | None = None) -> str:
    model = model or os.getenv("RUNPOD_OPENAI_MODEL") or DEFAULT_MODEL
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "hello"}],
        "max_tokens": 128,
        "temperature": 0,
    }
    response = _request_json("POST", "/v1/chat/completions", payload)
    return str(response["choices"][0]["message"]["content"])


def wait_and_send_hello() -> str:
    deadline = time.monotonic() + WAIT_TIMEOUT_S
    attempt = 1

    while True:
        try:
            return send_hello()
        except EndpointError as exc:
            if exc.status not in (502, 503, 504) or time.monotonic() >= deadline:
                raise

            print(
                f"Attempt {attempt}: endpoint still initializing "
                f"(HTTP {exc.status}); retrying in {RETRY_DELAY_S:g}s...",
                file=sys.stderr,
                flush=True,
            )
            attempt += 1
            time.sleep(RETRY_DELAY_S)


if __name__ == "__main__":
    try:
        check_endpoint()
        print(wait_and_send_hello())
    except EndpointError as exc:
        print(f"RunPod OpenAI smoke test failed: {exc}", file=sys.stderr)
        if exc.status == 502:
            print(
                "\n502 from proxy.runpod.net usually means the pod origin is not reachable. "
                "Check that the pod is running, port 8000 is exposed on the pod/template, "
                "and the OpenAI-compatible server is listening on 0.0.0.0:8000 inside the container.",
                file=sys.stderr,
            )
        raise SystemExit(1)
    except Exception as exc:
        print(f"RunPod OpenAI smoke test failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
