# 2026-05-04 — Upload queue + swappable VLM provider seam

Two architectural changes shipped, six atomic commits each.

## Upload job queue

Commits `687ed7f` → `3d1614d`.

`POST /api/upload` no longer touches Redis, `current_stream_url.txt`, or the Docker socket inline. It saves the file, ffprobes, inserts the `uploads` row, then `enqueue()`s into a new in-process `asyncio.Queue` ([`backend/app/upload_queue.py`](../../../backend/app/upload_queue.py)).

A serial worker task spawned in the FastAPI lifespan owns the side-effects:

1. Set `current_video_id`
2. Write the URI file
3. Restart `vss-rt-cv` via the docker socket
4. Wait for ingest plateau (3 consecutive identical `event_count` polls, armed after `min(15s, duration_s)`, hard cap `duration_s + 30s`)
5. Mark done, advance to next job

Exceptions are logged and swallowed so the worker keeps draining. Queue is depth-capped at `UPLOAD_QUEUE_MAX_DEPTH` (default 10) — over-capacity uploads get a 503 with `{"error":"queue full"}`.

**Behavior change.** Concurrent uploaders now serialize cleanly instead of racing on the global `current_video_id` key. The previous failure mode silently dropped all but the last upload's perception.

**API contract additions.**

- `POST /api/upload` response gains `queue_status` (`"queued" | "active"`) and `queue_position` (0-indexed)
- `GET /api/uploads/:id/progress` extended with `queue_status` (`"queued" | "active" | "done" | null`) and `queue_position`

**Frontend.** Conditional 6th leading "Queued" pill in the progress strip — only shown when `queue_status="queued"` at any point — with `"N ahead — waiting for DeepStream"` sub-text and 2 s poll cadence (vs 1 s for ingest). 503 from `POST /api/upload` renders the existing red error pill with `"Demo queue is full — try again in a moment."`

**Tests.** 21 backend tests still pass + 7 new for the queue (`test_upload_queue.py`).

**This is a workaround, not the cure.** The proper fix is multi-source via `nvstreammux` so the per-upload restart goes away entirely; logged as priority architectural debt in [`docs/v1/plan.md`](../../v1/plan.md).

## VLM provider seam

Commits `2095b07` → `da2ba56`.

[`backend/app/vlm_validator.py`](../../../backend/app/vlm_validator.py) now reads `VLM_PROVIDER=cosmos|openai` (default `cosmos`) and delegates to one of two isolated provider classes in [`backend/app/vlm_providers/`](../../../backend/app/vlm_providers/).

**`cosmos.py`** — existing NIM path with the model id env-driven (`COSMOS_MODEL`, default `nvidia/cosmos-reason2-2b`) so the planned 2b→8b swap is also a no-code change.

**`openai_provider.py`** — new. Extracts JPEG frames from the existing mp4 clip via ffmpeg (`fps=VLM_FRAME_FPS,scale=768:-2,-q:v 4`) into a `tempfile.TemporaryDirectory()` so frames don't pollute `/data/incidents/`. Sends them as base64 `image_url` content parts to `chat.completions.create` with `response_format=json_object` and `temperature=0.1`. Default model `gpt-5.4-mini`. Optional `OPENAI_BASE_URL` lets it point at any OAI-compatible endpoint (vLLM, Ollama, Together, etc.).

**Module isolation enforced.** Cosmos doesn't import OpenAI and vice versa, asserted by tests. Shared `prompts.py` and `parsing.py` mean both providers use the same prompt strings and verdict parser.

**`vlm_model` column** captures which model produced each verdict — mixed history is fine.

**Compose change.** `cosmos` service moved under `profiles: [gpu]` so plain `docker compose up` no longer pulls the 30 GB NIM image. Bring it up with `docker compose --profile gpu up -d`.

**New env vars** documented in `.env.example`: `VLM_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `COSMOS_MODEL`, `VLM_FRAME_FPS`.

**Tests.** 10 new tests (`test_vlm_providers.py`); total 31/31 pass.

## Three deployment topologies now supported by env alone

| Topology | Env |
|---|---|
| Monolith + local Cosmos (today's default) | `VLM_PROVIDER=cosmos` (no other change) |
| App + cloud OpenAI (T4 box, no GPU for VLM) | `VLM_PROVIDER=openai` + `OPENAI_API_KEY` + `OPENAI_MODEL=gpt-5.4-mini` |
| Split deploy: PaaS app + remote GPU box for Cosmos | `VLM_PROVIDER=cosmos` + `COSMOS_URL=https://gpu-host.example/...` |

## Not yet validated

Live OpenAI call against `gpt-5.4-mini` hasn't been made — tests stub `AsyncOpenAI`. First deploy with `VLM_PROVIDER=openai` should run analyze on `91_Country_Club-1777844748` (the open Cosmos-2B aftermath case from [2026-05-03](2026-05-03-rule-tuning-pickup.md)) and inspect the verdict + `vlm_model` column. Listed under "VLM provider follow-ups" in [`docs/v1/plan.md`](../../v1/plan.md).
