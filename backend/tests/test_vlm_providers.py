"""Tests for the VLM provider seam.

Uses the same _stub_app_imports() pattern as test_uploads_progress.py so that
FastAPI, asyncpg, openai, and httpx do not need to be installed in system Python.
"""

import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Stub heavy dependencies before importing any app module
# ---------------------------------------------------------------------------

def _stub_heavy_deps():
    """Insert minimal stubs so provider modules load without installed packages."""
    # httpx (used by cosmos provider)
    if "httpx" not in sys.modules:
        httpx_stub = types.ModuleType("httpx")

        class _FakeAsyncClient:
            def __init__(self, **kw):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                pass
            async def post(self, *a, **kw):
                raise RuntimeError("httpx not available in test environment")

        httpx_stub.AsyncClient = _FakeAsyncClient
        sys.modules["httpx"] = httpx_stub

    # openai (used by openai_provider)
    if "openai" not in sys.modules:
        openai_stub = types.ModuleType("openai")

        class _FakeAsyncOpenAI:
            def __init__(self, **kw):
                self.chat = MagicMock()

        openai_stub.AsyncOpenAI = _FakeAsyncOpenAI
        sys.modules["openai"] = openai_stub


_stub_heavy_deps()


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Helper to reload vlm_providers cleanly between tests
# ---------------------------------------------------------------------------

def _drop_provider_modules():
    """Remove cached provider modules so env changes take effect."""
    for key in list(sys.modules.keys()):
        if "vlm_providers" in key:
            del sys.modules[key]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestProviderSelector(unittest.TestCase):

    def setUp(self):
        _drop_provider_modules()
        # Clean env
        for var in ("VLM_PROVIDER", "COSMOS_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"):
            os.environ.pop(var, None)

    def tearDown(self):
        _drop_provider_modules()
        for var in ("VLM_PROVIDER", "COSMOS_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"):
            os.environ.pop(var, None)

    # 1. Default → cosmos
    def test_selector_returns_cosmos_by_default(self):
        from backend.app.vlm_providers import get_provider
        provider = get_provider()
        self.assertEqual(provider.name, "cosmos")
        self.assertEqual(provider.model_id, "nvidia/cosmos-reason2-2b")

    # 2. COSMOS_MODEL env override
    def test_selector_honors_cosmos_model_env(self):
        os.environ["VLM_PROVIDER"] = "cosmos"
        os.environ["COSMOS_MODEL"] = "nvidia/cosmos-reason2-8b"
        from backend.app.vlm_providers import get_provider
        provider = get_provider()
        self.assertEqual(provider.model_id, "nvidia/cosmos-reason2-8b")

    # 3. VLM_PROVIDER=openai
    def test_selector_returns_openai_when_set(self):
        os.environ["VLM_PROVIDER"] = "openai"
        os.environ["OPENAI_API_KEY"] = "test-key"
        os.environ["OPENAI_MODEL"] = "gpt-5.4-mini"
        from backend.app.vlm_providers import get_provider
        provider = get_provider()
        self.assertEqual(provider.name, "openai")
        self.assertEqual(provider.model_id, "gpt-5.4-mini")

    # 4. Unknown provider raises ValueError
    def test_selector_invalid_value_raises(self):
        os.environ["VLM_PROVIDER"] = "garbage"
        from backend.app.vlm_providers import get_provider
        with self.assertRaises(ValueError) as ctx:
            get_provider()
        self.assertIn("garbage", str(ctx.exception))

    # 5. OpenAI missing API key raises at construction
    def test_openai_missing_api_key_raises(self):
        os.environ["VLM_PROVIDER"] = "openai"
        os.environ["OPENAI_MODEL"] = "gpt-5.4-mini"
        os.environ.pop("OPENAI_API_KEY", None)
        from backend.app.vlm_providers import get_provider
        with self.assertRaises((ValueError, KeyError)):
            get_provider()


class TestOpenAIProviderValidate(unittest.TestCase):
    """Tests for OpenAIProvider.validate() using stubbed AsyncOpenAI and ffmpeg."""

    def setUp(self):
        _drop_provider_modules()
        os.environ["VLM_PROVIDER"] = "openai"
        os.environ["OPENAI_API_KEY"] = "test-key"
        os.environ["OPENAI_MODEL"] = "gpt-5.4-mini"

    def tearDown(self):
        _drop_provider_modules()
        for var in ("VLM_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"):
            os.environ.pop(var, None)

    def _make_fake_response(self, content: str):
        """Build a mock object that looks like openai.ChatCompletion response."""
        message = MagicMock()
        message.content = content
        choice = MagicMock()
        choice.message = message
        response = MagicMock()
        response.choices = [choice]
        return response

    def _make_provider_with_stub_client(self, response_content: str):
        """Return an OpenAIProvider with its AsyncOpenAI client stubbed out."""
        from backend.app.vlm_providers.openai_provider import OpenAIProvider
        provider = OpenAIProvider()
        # Replace the real client with a stub
        fake_response = self._make_fake_response(response_content)
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=fake_response)
        provider._client = mock_client
        return provider

    def _run_validate_with_fake_frames(self, provider, frame_contents: list[bytes], rule_id: str = "vehicle_collision"):
        """Call provider.validate() with _extract_frames patched to return temp frame paths."""
        import tempfile

        async def _fake_extract_frames(clip_path, tmpdir):
            # Write fake JPEG bytes into tmpdir and return paths
            paths = []
            for i, data in enumerate(frame_contents):
                p = Path(tmpdir) / f"f{i:02d}.jpg"
                p.write_bytes(data)
                paths.append(p)
            return paths

        with patch("backend.app.vlm_providers.openai_provider._extract_frames", _fake_extract_frames):
            return _run(provider.validate(Path("/fake/clip.mp4"), rule_id))

    # 6. Parse confirmed response
    def test_openai_validate_parses_response(self):
        content = '{"verdict":"confirmed","confidence":0.85,"reasoning":"vehicles in contact"}'
        provider = self._make_provider_with_stub_client(content)
        verdict, reasoning, confidence = self._run_validate_with_fake_frames(provider, [b"fakejpeg"])
        self.assertEqual(verdict, "confirmed")
        self.assertEqual(reasoning, "vehicles in contact")
        self.assertAlmostEqual(confidence, 0.85)

    # 7. Malformed content → uncertain fallback
    def test_openai_validate_handles_uncertain(self):
        content = "I cannot determine this from the frames provided."
        provider = self._make_provider_with_stub_client(content)
        verdict, reasoning, confidence = self._run_validate_with_fake_frames(provider, [b"fakejpeg"])
        self.assertEqual(verdict, "uncertain")
        self.assertAlmostEqual(confidence, 0.5)

    # 8. Strips <think> block before parsing
    def test_openai_validate_strips_think_block(self):
        content = '<think>thinking out loud</think>{"verdict":"rejected","confidence":0.7,"reasoning":"normal traffic"}'
        provider = self._make_provider_with_stub_client(content)
        verdict, reasoning, confidence = self._run_validate_with_fake_frames(provider, [b"fakejpeg"])
        self.assertEqual(verdict, "rejected")
        self.assertEqual(reasoning, "normal traffic")
        self.assertAlmostEqual(confidence, 0.7)


class TestModuleIsolation(unittest.TestCase):
    """Verify provider modules do not leak cross-provider symbols."""

    def setUp(self):
        _drop_provider_modules()
        os.environ.pop("VLM_PROVIDER", None)

    def tearDown(self):
        _drop_provider_modules()

    # 9. Importing cosmos.py must not import openai
    def test_cosmos_provider_isolation(self):
        before = set(sys.modules.keys())
        import backend.app.vlm_providers.cosmos  # noqa: F401
        after = set(sys.modules.keys())
        new_modules = after - before
        openai_modules = {m for m in new_modules if m == "openai" or m.startswith("openai.")}
        self.assertEqual(openai_modules, set(), f"cosmos imported openai symbols: {openai_modules}")

    # 10. Importing openai_provider.py must not introduce Cosmos-specific names
    def test_openai_provider_isolation(self):
        # We verify that no cosmos-specific names are injected into the module's
        # namespace when we import openai_provider.
        import backend.app.vlm_providers.openai_provider as oai_mod
        cosmos_names = [name for name in dir(oai_mod) if "cosmos" in name.lower()]
        self.assertEqual(cosmos_names, [], f"openai_provider has Cosmos symbols: {cosmos_names}")


if __name__ == "__main__":
    unittest.main()
