"""Runtime dev-only overrides for backend behaviour.

Currently exposes a VLM provider override so the settings page can swap
between cosmos and openai without a backend restart. Override lives in
process memory only — restart reverts to the VLM_PROVIDER env value.
"""

import logging
import os
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger("app.dev_settings")

VLM_PROVIDERS = ("cosmos", "openai")
VlmProvider = Literal["cosmos", "openai"]

# Runtime override; None means "fall back to env".
_vlm_override: VlmProvider | None = None


def get_active_vlm_provider() -> str:
    """Return the runtime override if set, else the VLM_PROVIDER env value."""
    if _vlm_override is not None:
        return _vlm_override
    return os.getenv("VLM_PROVIDER", "cosmos").lower().strip()


def env_default_vlm_provider() -> str:
    return os.getenv("VLM_PROVIDER", "cosmos").lower().strip()


router = APIRouter(prefix="/api/dev")


class VlmProviderState(BaseModel):
    active: str
    env_default: str
    available: list[str]
    overridden: bool


class VlmProviderUpdate(BaseModel):
    provider: VlmProvider


@router.get("/vlm-provider", response_model=VlmProviderState)
async def get_vlm_provider_state() -> VlmProviderState:
    return VlmProviderState(
        active=get_active_vlm_provider(),
        env_default=env_default_vlm_provider(),
        available=list(VLM_PROVIDERS),
        overridden=_vlm_override is not None,
    )


@router.post("/vlm-provider", response_model=VlmProviderState)
async def set_vlm_provider(body: VlmProviderUpdate) -> VlmProviderState:
    global _vlm_override
    if body.provider not in VLM_PROVIDERS:
        raise HTTPException(status_code=400, detail="invalid_provider")
    _vlm_override = body.provider
    log.info(
        "dev_settings.vlm_provider.override",
        extra={"provider": body.provider, "env_default": env_default_vlm_provider()},
    )
    return await get_vlm_provider_state()


@router.delete("/vlm-provider", response_model=VlmProviderState)
async def clear_vlm_provider_override() -> VlmProviderState:
    """Drop the runtime override and revert to the env-configured provider."""
    global _vlm_override
    _vlm_override = None
    log.info("dev_settings.vlm_provider.override_cleared")
    return await get_vlm_provider_state()
