import os
import json
import logging
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.auth import verify_ws_token
from app.redis_client import stream_events

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

router = APIRouter()
log = logging.getLogger(__name__)


@router.websocket("/ws/events")
async def websocket_endpoint(websocket: WebSocket, token: str | None = None):
    # WS upgrade can't carry Authorization headers from browsers, so we accept
    # the Supabase JWT via query string (?token=...). The stream is still the
    # global mdx-raw firehose for now; per-user filtering depends on Phase F1
    # (source-id tagging in event payloads).
    try:
        user = verify_ws_token(token)
    except HTTPException as exc:
        await websocket.close(code=4401)
        log.info("websocket.events.unauthorized", extra={"reason": exc.detail})
        return

    await websocket.accept()
    log.info("websocket.events.connected", extra={"user_id": user["user_id"]})
    try:
        async for message in stream_events(f"redis://{REDIS_HOST}:{REDIS_PORT}"):
            await websocket.send_json(message)
    except WebSocketDisconnect:
        log.info("websocket.events.disconnected")
    except Exception as e:
        log.exception("websocket.events.error", extra={"error": str(e)})
        await websocket.close(code=1000)
