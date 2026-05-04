import os
import asyncio
import logging
from contextlib import asynccontextmanager
import redis.asyncio as redis
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.logging_config import (
    Timer,
    configure_logging,
    new_request_id,
    reset_request_id,
    set_request_id,
)
from app.upload import router as upload_router
from app.playback import router as playback_router
from app.events import router as events_router
from app.uploads_list import router as uploads_list_router
from app.incidents import router as incidents_router
from app.sdr import remove_active_stream
from app.redis_client import clear_stream
from app.db import init_pool, close_pool
from app.event_indexer import run_indexer
from app.upload_queue import start_worker, stop_worker

DATA_DIR = os.getenv("DATA_DIR", "/data")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

configure_logging()
log = logging.getLogger(__name__)

redis_client = None
_indexer_task: asyncio.Task | None = None
_queue_worker_task: asyncio.Task | None = None


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or new_request_id()
        token = set_request_id(request_id)
        timer = Timer()
        try:
            response = await call_next(request)
            response.headers["x-request-id"] = request_id
            log.info(
                "http.request.complete",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": response.status_code,
                    "duration_ms": timer.duration_ms,
                },
            )
            return response
        except Exception:
            log.exception(
                "http.request.error",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": timer.duration_ms,
                },
            )
            raise
        finally:
            reset_request_id(token)


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method in ["POST", "PUT", "PATCH"]:
            content_length = request.headers.get("content-length")
            if content_length:
                size = int(content_length)
                if size > 500 * 1024 * 1024:
                    log.warning(
                        "http.request.body_too_large",
                        extra={
                            "method": request.method,
                            "path": request.url.path,
                            "content_length": size,
                        },
                    )
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Request body too large (max 500MB)"},
                    )
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client, _indexer_task, _queue_worker_task

    log.info("backend.start")

    # Postgres
    await init_pool()
    log.info("postgres.pool.ready")

    # Redis
    redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    try:
        await redis_client.ping()
    except Exception:
        log.critical(
            "redis.boot_connect.failed",
            extra={"redis_host": REDIS_HOST, "redis_port": REDIS_PORT},
            exc_info=True,
        )
        raise
    log.info("redis.connected", extra={"redis_host": REDIS_HOST, "redis_port": REDIS_PORT})

    # Event indexer
    redis_url = f"redis://{REDIS_HOST}:{REDIS_PORT}"
    _indexer_task = asyncio.create_task(run_indexer(redis_url))
    log.info("event_indexer.task.started")

    # Upload queue worker
    from app.db import get_pool as _get_pool
    _queue_worker_task = start_worker(_get_pool())
    log.info("upload_queue.worker.task.started")

    yield

    # Shutdown
    log.info("backend.shutdown.start")
    if _indexer_task is not None:
        _indexer_task.cancel()
        try:
            await _indexer_task
        except asyncio.CancelledError:
            pass

    await stop_worker()

    if redis_client is not None:
        await redis_client.aclose()
    await close_pool()
    log.info("backend.shutdown.complete")


app = FastAPI(title="SSI AIMS v1", lifespan=lifespan)

app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestIdMiddleware)

app.include_router(upload_router)
app.include_router(playback_router)
app.include_router(events_router)
app.include_router(uploads_list_router)
app.include_router(incidents_router)


@app.get("/healthz")
@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/reset")
async def reset():
    redis_url = f"redis://{REDIS_HOST}:{REDIS_PORT}"
    await remove_active_stream()
    await clear_stream(redis_url)
    return {"status": "reset"}
