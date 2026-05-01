import os
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.redis_client import stream_events

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

router = APIRouter()
log = logging.getLogger(__name__)


@router.websocket("/ws/events")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    log.info("websocket.events.connected")
    try:
        async for message in stream_events(f"redis://{REDIS_HOST}:{REDIS_PORT}"):
            await websocket.send_json(message)
    except WebSocketDisconnect:
        log.info("websocket.events.disconnected")
    except Exception as e:
        log.exception("websocket.events.error", extra={"error": str(e)})
        await websocket.close(code=1000)
