"""Cosmos NIM VLM provider.

Calls the self-hosted Cosmos-Reason2 NIM container via HTTP.
Does NOT import or reference any OpenAI symbol.
"""

import base64
import os
from pathlib import Path

import httpx

from .parsing import parse_verdict
from .prompts import PROMPTS

COSMOS_URL = os.getenv("COSMOS_URL", "http://cosmos:8000")
VLM_TIMEOUT_S = float(os.getenv("VLM_TIMEOUT_S", "120.0"))


class CosmosProvider:
    """VLM provider backed by the NVIDIA Cosmos-Reason2 NIM."""

    def __init__(self) -> None:
        self.model_id: str = os.getenv("COSMOS_MODEL", "nvidia/cosmos-reason2-2b")
        self.name: str = "cosmos"

    async def validate(self, clip_path: Path, rule_id: str) -> tuple[str, str, float]:
        """Send clip to Cosmos NIM. Returns (verdict, reasoning, confidence)."""
        prompt = PROMPTS.get(rule_id, PROMPTS["vehicle_collision"])
        b64 = base64.b64encode(clip_path.read_bytes()).decode()
        payload = {
            "model": self.model_id,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "max_tokens": 512,
            "temperature": 0.1,
        }
        async with httpx.AsyncClient(timeout=VLM_TIMEOUT_S) as client:
            resp = await client.post(f"{COSMOS_URL}/v1/chat/completions", json=payload)
            resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        verdict, confidence, reasoning = parse_verdict(content)
        return verdict, reasoning, confidence
