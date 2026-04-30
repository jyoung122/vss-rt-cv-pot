import os
import asyncio
from contextlib import asynccontextmanager
import redis.asyncio as redis
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.upload import router as upload_router
from app.playback import router as playback_router
from app.events import router as events_router
from app.uploads_list import router as uploads_list_router
from app.sdr import remove_active_stream
from app.redis_client import clear_stream
from app.db import init_pool, close_pool
from app.event_indexer import run_indexer

DATA_DIR = os.getenv("DATA_DIR", "/data")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

redis_client = None
_indexer_task: asyncio.Task | None = None


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method in ["POST", "PUT", "PATCH"]:
            content_length = request.headers.get("content-length")
            if content_length:
                size = int(content_length)
                if size > 500 * 1024 * 1024:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Request body too large (max 500MB)"},
                    )
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client, _indexer_task

    # Postgres
    await init_pool()

    # Redis
    redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    try:
        await redis_client.ping()
    except Exception as e:
        print(f"Redis connection warning: {e}")

    # Event indexer
    redis_url = f"redis://{REDIS_HOST}:{REDIS_PORT}"
    _indexer_task = asyncio.create_task(run_indexer(redis_url))

    yield

    # Shutdown
    if _indexer_task is not None:
        _indexer_task.cancel()
        try:
            await _indexer_task
        except asyncio.CancelledError:
            pass

    await redis_client.aclose()
    await close_pool()


app = FastAPI(title="SSI AIMS v1", lifespan=lifespan)

app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload_router)
app.include_router(playback_router)
app.include_router(events_router)
app.include_router(uploads_list_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/reset")
async def reset():
    redis_url = f"redis://{REDIS_HOST}:{REDIS_PORT}"
    await remove_active_stream()
    await clear_stream(redis_url)
    return {"status": "reset"}
