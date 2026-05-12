import hashlib
import os
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

_bearer = HTTPBearer()


def _decode_token(token: str) -> dict:
    """Decode + validate a Supabase JWT. Raises HTTPException on failure."""
    secret = os.getenv("SUPABASE_JWT_SECRET")
    if not secret:
        raise HTTPException(status_code=503, detail="auth_not_configured")

    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="invalid_token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="invalid_token")

    return {"user_id": user_id, "email": payload.get("email")}


def require_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    return _decode_token(credentials.credentials)


def verify_ws_token(token: str | None) -> dict:
    """WebSocket-friendly variant: takes raw token (typically from query string)."""
    if not token:
        raise HTTPException(status_code=401, detail="missing_token")
    return _decode_token(token)


def user_short(user_id: str) -> str:
    """Short, opaque, stable prefix for embedding in video_id (avoids cross-tenant guessing)."""
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:8]
