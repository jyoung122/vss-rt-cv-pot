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

    Reads VLM_PROVIDER (default: "cosmos").
    Raises ValueError immediately if the env value is unrecognised or required
    env vars are missing, so misconfiguration surfaces at startup rather than
    at the first incident.
    """
    provider_name = os.getenv("VLM_PROVIDER", "cosmos").lower().strip()

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
