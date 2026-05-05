# 2026-05-05 — Collision window fix + live VLM validation against two providers

Closes the open question from [2026-05-03 rule-tuning pickup](2026-05-03-rule-tuning-pickup.md). The 2B-rejects-the-collision finding wasn't a model-capacity issue — the clip never contained the visible aftermath. Both gpt-5.4-mini and alibaba/qwen3.5-flash confirm at high confidence once the window is widened.

## Setup

Existing A6000 host, stack already up. Uploaded `91_Country_Club.mp4` fresh as `91_Country_Club-1777939152` (DB had been wiped from the 2026-05-03 session). Pipeline produced 6,457 events; rule pack fired the same three incidents as yesterday — `vehicle_collision` on tracks (9, 10) at t=15.13-59.87s (rule_conf 0.87), `stationary_vehicle` on track 9 at t=37.07-54.87s, `ped_impact` on tracks (32, 33) at t=57.80-59.87s.

`.env`: `VLM_PROVIDER=openai`, `OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v1`, `OPENAI_API_KEY` set. Vercel's AI Gateway is OpenAI-compatible — the existing `AsyncOpenAI` client works as a drop-in proxy via `base_url`. **No `ai` SDK involved.**

## Bug found and fixed: gateway rejects `response_format`

First analyze run with `OPENAI_MODEL=gpt-5.4-mini`: all three incidents wrote `vlm_status='error'`. Backend log showed every call returning HTTP 400:

```
{'message': 'Invalid input', 'param': 'response_format', 'code': 'invalid_request_error'}
```

[`openai_provider.py:83`](../../../backend/app/vlm_providers/openai_provider.py) was sending `response_format={"type": "json_object"}`. The Vercel gateway rejects that param for `gpt-5.4-mini` (and for `alibaba/qwen3.5-flash`). The shared parser at [`parsing.py:13`](../../../backend/app/vlm_providers/parsing.py) already regex-extracts the verdict JSON from raw text, and every prompt in [`prompts.py`](../../../backend/app/vlm_providers/prompts.py) ends with `Respond ONLY with JSON: {...}` — so json-mode was redundant. Dropped it. Commit `6b768bd`.

## Window-fix discovery (the actual finding)

After the gateway fix, gpt-5.4-mini returned **rejected/0.93** on the (9, 10) collision. Reasoning: "no visible collision, damage, debris, smoke, fluid, or abnormal stopping." Same verdict from `alibaba/qwen3.5-flash`: **rejected/0.95** with "no signs of collision, damage, debris, or abnormal stopping."

That matched yesterday's Cosmos-2B verdict almost word-for-word. **Three independent VLMs at three different sizes all rejected with the same reasoning** — that's not a capacity story, that's all three seeing the same clip and being right about what they were shown.

Per-rule windows in [`vlm_validator.py:_clip_window`](../../../backend/app/vlm_validator.py):

| rule | window | covered for (9, 10) |
|---|---|---|
| vehicle_collision | `[iou_peak_t - 2, iou_peak_t + 6]` | 13.13 → 21.13 s — impact moment, **cuts off where debris appears** |
| stationary_vehicle | `[t_start_s, t_start_s + 8]` | 37.07 → 45.07 s — past the debris, into the stopped tail |

Yesterday's note placed the visible debris at **t ≈ 21-25 s**. So the 8-second collision clip ended *exactly where the evidence began*, and the stationary-vehicle clip started 12 seconds after the debris was on the ground. The model was never given the diagnostic frames.

Widened to 20 s (`+18` post-peak) in commit `1fe6291`. Same model, same prompt, same temperature.

## Verdicts after the window fix

`alibaba/qwen3.5-flash` on the 20 s window:

| rule | verdict | conf | latency |
|---|---|---:|---:|
| vehicle_collision (9,10) | confirmed | 0.95 | 10.9 s |
| stationary_vehicle (9) | confirmed | 0.95 | 8.5 s |
| ped_impact (32,33) | rejected | 0.95 | 10.8 s |

Reasoning on the collision: *"white SUV colliding with the side of a black pickup truck in an intersection, followed by visible debris on the road and both vehicles coming to a stop."* The stationary verdict also picked up the debris cue (*"with debris nearby, clearly obstructing the lane"*) — the 8-second window had described it only positionally.

`gpt-5.4-mini` on the 20 s window:

| rule | verdict | conf | latency |
|---|---|---:|---:|
| vehicle_collision (9,10) | confirmed | 0.98 | 4.7 s |
| stationary_vehicle (9) | confirmed | 0.96 | 2.9 s |
| ped_impact (32,33) | rejected | 0.97 | 1.5 s |

Reasoning: *"A collision is clearly visible at 07:47:29 with two vehicles contacting and debris scattered on the roadway afterward."*

### Cross-model summary on the (9, 10) collision

| model | window | verdict | conf | latency | sees debris |
|---|---:|---|---:|---:|---|
| Cosmos-Reason2-2B | 8 s | rejected | 0.95 | (yesterday) | no |
| gpt-5.4-mini | 8 s | rejected | 0.93 | 3.0 s | no |
| qwen3.5-flash | 8 s | rejected | 0.95 | 37.3 s | no |
| qwen3.5-flash | **20 s** | **confirmed** | 0.95 | 10.9 s | yes |
| gpt-5.4-mini | **20 s** | **confirmed** | **0.98** | **4.7 s** | yes |

Cosmos-2B was not retested today — host has only 11 GB free disk, the NIM image is ~30 GB. Yesterday's Brev/Shadeform A100 hosts had room; this A6000 doesn't. Two providers agreeing at high confidence on the corrected window is sufficient evidence to retire the "2B may be capacity-limited" hypothesis from [`snapshot.md`](../snapshot.md).

## Aside: qwen3.5-flash thinking is on by default

Probed the gateway with a 37-token echo prompt:

```
completion_tokens   = 740
  reasoning_tokens  = 713   ← thinking
  visible content   =  27   (the JSON answer)
```

Gateway strips reasoning tokens server-side before returning, so the `<think>` regex in `parsing.py` never matches. The 37 s collision-clip latency at 8 s window collapsed to ~10 s at 20 s window — same model, same thinking mode, less per-call variance than I'd have guessed. Disabling thinking via `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` is a known knob if latency ever matters; not pursued today.

## Commits

- `6b768bd` — fix(vlm): drop `response_format` for OpenAI gateway compatibility
- `1fe6291` — tune(vlm): widen `vehicle_collision` clip window 8s → 20s

Both atomic, on `main`, not pushed.

## What this changes elsewhere in the repo

Stale claims now corrected in `snapshot.md`:

- `_clip_window` description (line ~41) — `vehicle_collision` is 20 s, not 8 s.
- `openai_provider.py` description (line ~49) — no longer sends `response_format`.
- Known-issue "Cosmos-Reason2-2B may be capacity-limited" (line ~123) — retired; reframed as window framing.
- Next-steps #1 (line ~147) — live VLM validation done.

`plan.md` follow-up "Live validation against `gpt-5.4-mini`" (line ~183) — done.

## Not done today

- **Provider badge in the Why panel** ([plan.md:184](../../v1/plan.md#L184)) — frontend chip distinguishing Cosmos vs OpenAI verdicts. Useful now that we have multi-provider verdicts in the demo path.
- **Runbook punch list** ([snapshot.md:131-133](../snapshot.md#L131)) — `scripts/vm_setup.sh` ngc CLI bundle bug + `deploy.md` step-7 wording about clicking seeded rows.
- **Cosmos validation on 20 s window** — wants a host with ≥30 GB free disk for the NIM pull. Not blocking; two providers agree.
