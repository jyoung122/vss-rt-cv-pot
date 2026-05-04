"""Shared response parsing for VLM providers."""

import json
import re


def parse_verdict(content: str) -> tuple[str, float, str]:
    """Extract verdict/confidence/reasoning from model response, stripping <think> blocks.

    Returns (verdict, confidence, reasoning).
    """
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
    match = re.search(r"\{[^{}]*\"verdict\"[^{}]*\}", content, re.DOTALL)
    if not match:
        return "uncertain", 0.5, content[:300]
    try:
        data = json.loads(match.group())
        verdict = data.get("verdict", "uncertain")
        if verdict not in ("confirmed", "rejected", "uncertain"):
            verdict = "uncertain"
        confidence = float(data.get("confidence", 0.5))
        confidence = max(0.0, min(1.0, confidence))
        reasoning = str(data.get("reasoning", ""))[:500]
        return verdict, confidence, reasoning
    except Exception:
        return "uncertain", 0.5, content[:300]
