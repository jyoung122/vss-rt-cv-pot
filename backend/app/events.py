import os
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.redis_client import stream_events

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

router = APIRouter()


@router.websocket("/ws/events")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        async for message in stream_events(f"redis://{REDIS_HOST}:{REDIS_PORT}"):
            await websocket.send_json(message)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
        await websocket.close(code=1000)
