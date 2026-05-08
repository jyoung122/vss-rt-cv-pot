"""VLM provider package.

Exports:
    VLMProvider  — Protocol describing the provider interface
    get_provider — factory that reads VLM_PROVIDER env var and returns the right instance
"""

import os
from pathlib import Path
from typing import Protocol, runtime_checkable

from .parsing import parse_verdict  # re-export for external consumers

__all__ = ["VLMProvider", "get_provider", "parse_verdict"]


@runtime_checkable
class VLMProvider(Protocol):
    name: str      # "cosmos" | "openai"
    model_id: str  # value written to the vlm_model column

    async def validate(self, clip_path: Path, rule_id: str) -> tuple[str, str, float]:
        """Analyse the clip and return (verdict, reasoning, confidence)."""
        ...


def get_provider() -> VLMProvider:
    """Instantiate and return the configured VLM provider.

    Honours a runtime override from app.dev_settings (set via the settings UI)
    if present; otherwise reads VLM_PROVIDER env (default: "cosmos").
    Raises ValueError immediately if the value is unrecognised or required
    env vars are missing, so misconfiguration surfaces at the first call
    rather than silently falling back.
    """
    # Local import to avoid circular import at module load time.
    from app.dev_settings import get_active_vlm_provider
    provider_name = get_active_vlm_provider()

    if provider_name == "cosmos":
        from .cosmos import CosmosProvider
        return CosmosProvider()

    if provider_name == "openai":
        from .openai_provider import OpenAIProvider
        return OpenAIProvider()

    raise ValueError(
        f"Unknown VLM_PROVIDER={provider_name!r}. "
        "Valid values are: 'cosmos', 'openai'."
    )
