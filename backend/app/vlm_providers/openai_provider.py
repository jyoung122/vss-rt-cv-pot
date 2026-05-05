"""OpenAI (chat completions) VLM provider.

Extracts frames from the clip via ffmpeg and sends them as base64 image_url
content parts to any OpenAI-compatible endpoint.
Does NOT import or reference any Cosmos symbol.
"""

import asyncio
import base64
import os
import tempfile
from pathlib import Path

from openai import AsyncOpenAI

from .parsing import parse_verdict
from .prompts import PROMPTS

VLM_TIMEOUT_S = float(os.getenv("VLM_TIMEOUT_S", "120.0"))
VLM_FRAME_FPS = float(os.getenv("VLM_FRAME_FPS", "1"))


async def _extract_frames(clip_path: Path, tmpdir: str) -> list[Path]:
    """Extract JPEG frames from clip at VLM_FRAME_FPS into tmpdir."""
    output_pattern = os.path.join(tmpdir, "f%02d.jpg")
    cmd = [
        "ffmpeg", "-y",
        "-ss", "0",
        "-i", str(clip_path),
        "-vf", f"fps={VLM_FRAME_FPS},scale=768:-2",
        "-q:v", "4",
        output_pattern,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    frames = sorted(Path(tmpdir).glob("f*.jpg"))
    return frames


class OpenAIProvider:
    """VLM provider backed by OpenAI chat completions (or any OAI-compatible endpoint)."""

    def __init__(self) -> None:
        self.name: str = "openai"
        self.model_id: str = os.environ["OPENAI_MODEL"]

        api_key = os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY is required when VLM_PROVIDER=openai. "
                "Set it in your .env file or environment."
            )

        base_url = os.getenv("OPENAI_BASE_URL") or None
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=VLM_TIMEOUT_S,
        )

    async def validate(self, clip_path: Path, rule_id: str) -> tuple[str, str, float]:
        """Extract frames from clip and send to OpenAI. Returns (verdict, reasoning, confidence)."""
        prompt = PROMPTS.get(rule_id, PROMPTS["vehicle_collision"])

        with tempfile.TemporaryDirectory() as tmpdir:
            frames = await _extract_frames(clip_path, tmpdir)

            content: list[dict] = [{"type": "text", "text": prompt}]
            for frame_path in frames:
                b64 = base64.b64encode(frame_path.read_bytes()).decode()
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                })

            response = await self._client.chat.completions.create(
                model=self.model_id,
                messages=[{"role": "user", "content": content}],
                temperature=0.1,
            )

        raw = response.choices[0].message.content or ""
        verdict, confidence, reasoning = parse_verdict(raw)
        return verdict, reasoning, confidence
