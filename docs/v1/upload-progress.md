# Upload progress — real-signal pipeline strip

This was the original design doc for the 5-stage progress strip. Now shipped, plus a conditional 6th leading "Queued" stage that landed alongside the upload job queue (commit `3d1614d`). Live behaviour:

```
[Queued →] Uploading → Ingesting → Detecting rules → Validating → Done
```

The `Queued` pill only appears when the backend's enqueue response returns `queue_status="queued"` — i.e. another upload is already owning the DeepStream container. The hook polls `/progress` every 2 s while queued (vs 1 s for ingest), shows `"N ahead — waiting for DeepStream"` sub-text, and advances out of the queued state when `queue_status` flips to `"active"`. A 503 from `POST /api/upload` (queue full) renders the existing red error pill with `"Demo queue is full — try again in a moment."`

The rest of this doc describes the original 5-stage design as shipped. Replaces the fake 4-stage timer in [`frontend/src/app/uploads/page.tsx`](../../frontend/src/app/uploads/page.tsx) with a state machine driven by real backend signals. Auto-triggers `/analyze` so VLM fires for new uploads without manual curl.

Current state: post-upload stages advance every 1400 ms with `setTimeout`. None of the stages reflect actual backend progress, and `/analyze` is never called automatically — VLM only runs for uploads where someone manually `curl`s the analyze endpoint.

---

## Architecture

**Frontend-driven orchestration.** The state machine and polling live in the browser, not in the upload handler. Trade-off: closing the tab mid-pipeline means VLM never runs (acceptable for the demo). A backend orchestrator would solve that and is out of scope here.

The indexer has no EOS hook ([`backend/app/event_indexer.py:10-12`](../../backend/app/event_indexer.py#L10-L12)) — the FE detects "ingest done" by polling `event_count` plateau, not by waiting for a sentinel.

---

## Stage signals

| Stage | Enter when | Exit when | Source |
|---|---|---|---|
| 0 upload | `POST /api/upload` starts | HTTP 200 with `video_id` | XHR progress event |
| 1 ingest | upload response received | `event_count` plateaus for ≥3 polls **or** wall ≥ `duration_s + 5s` | `GET /api/uploads/:id/progress` every 1 s |
| 2 rules | ingest complete | `POST /api/uploads/:id/analyze` returns | one fetch, await response |
| 3 vlm | analyze response with `incidents_found > 0` and VLM enabled | `vlm_pending = 0` | `GET /api/uploads/:id/progress` every 2 s |
| 4 done | vlm settled (or skipped) | auto-resets after 1.5 s | already exists |

**Skip rules** (jump straight to done):
- `incidents_found === 0`
- `vlm_enabled === false`
- All incident rows return `vlm_status='skipped'`

**Analyze error codes** (`POST /api/uploads/:id/analyze`):

| Status | Meaning | Frontend treatment |
|---|---|---|
| `200` | Rule pack ran; `incidents_found > 0` | Enter VLM stage |
| `422` | Pipeline completed but found no events — legitimate empty video | Silent done (0 incidents) |
| `503` | `dss_status != 'completed'` — vss-rt-cv did not finish processing | Error pill: "Detection pipeline unavailable" |

`dss_status` is written to the `uploads` table by the queue worker: `pending` → `processing` (after container restart) → `completed` (plateau reached) or `failed` (hard timeout or exception). A 422 is only returned when `dss_status = 'completed'` — meaning DeepStream ran to completion but the video had no detectable objects.

---

## Plateau heuristic

`event_count` is monotonic during indexing. "Plateaued" = same value across **3 consecutive 1-second polls**.

- **Hard cap**: `min(plateau, duration_s + 5s)` so we never spin if the indexer stalls.
- **Min ingest wait**: `min(15s, duration_s)` before plateau detection arms — prevents premature rule-pack firing on short clips that briefly stall mid-ingest.

---

## Backend addition

One new aggregate endpoint at [`backend/app/uploads_list.py`](../../backend/app/uploads_list.py):

### `GET /api/uploads/:id/progress`

Single SQL with two LEFT JOINs (events for count, incidents for vlm split). One env read for `VLM_ENABLED`. ~30 LOC + tests.

**Response shape (locked contract — extended for queue):**

```json
{
  "video_id": "115_and_HVP-1777838948",
  "duration_s": 148.8,
  "event_count": 28296,
  "incidents_total": 7,
  "vlm_pending": 0,
  "vlm_done": 7,
  "vlm_skipped": 0,
  "vlm_error": 0,
  "vlm_enabled": true,
  "queue_status": "done",
  "queue_position": null
}
```

`queue_status` is one of `"queued" | "active" | "done" | null` (`null` for legacy rows that pre-date the queue). `queue_position` is 0-indexed (0 = next up) while queued; `null` otherwise.

`vlm_*` fields are counts of `incidents.vlm_status` values. `vlm_enabled` reflects the runtime env var read from `os.environ.get("VLM_ENABLED")`.

**404 → upload not found.** No 422 path; return zeros for missing data.

---

## Frontend changes

### New custom hook
[`frontend/src/lib/use-upload-progress.ts`](../../frontend/src/lib/) — encapsulates the state machine, polling, plateau detection, and auto-trigger. Returns:

```ts
{
  stage: 'idle' | 'upload' | 'ingest' | 'rules' | 'vlm' | 'done' | 'error',
  percent: number,           // upload XHR progress; 0 outside upload stage
  sub: string | null,        // e.g. "12 / 57 validated" during VLM
  error: string | null,      // surfaced from /analyze or polling failures
}
```

### Replace fake timer
[`frontend/src/app/uploads/page.tsx:81-119`](../../frontend/src/app/uploads/page.tsx#L81-L119) — drop the `setTimeout` chain, wire `useUploadProgress(videoId)` into the active-upload card, and let the hook own stage transitions.

### Auto-trigger analyze
Inside the hook, on `ingest → rules` transition, fire one `POST /api/uploads/:id/analyze`. Use its `incidents_found` to decide whether stage 3 fires or we skip-to-done.

### Stage labels
Pills on the existing strip:

```
Uploading → Ingesting → Detecting rules → Validating → Done
```

Sub-text under the active pill (~10 px, opacity 60):
- During ingest: `12 480 events`
- During VLM: `12 / 57 validated`
- During rules: `running…`

### VLM-disabled / skipped variant
When `vlm_enabled === false` or all incidents are `skipped`, render the VLM pill greyed-out with `—` instead of a count, and transition straight to done.

### Error variant
On `vlm_error > 0` or any polling 5xx, surface a red **Error** pill with the error string visible on hover (use existing tooltip primitive). Don't auto-retry — let the user reload.

---

## Files touched

| File | Change | LOC est. |
|---|---|---|
| `backend/app/uploads_list.py` | Add `/api/uploads/:id/progress` endpoint | +30 |
| `backend/tests/test_uploads_progress.py` (new) | SQL aggregate cases (zeros / mid-pipeline / settled) | +60 |
| `frontend/src/lib/use-upload-progress.ts` (new) | State machine + polling + plateau | +120 |
| `frontend/src/app/uploads/page.tsx` | Wire hook, drop fake timer, render new pill | ~−40 / +30 |
| Progress strip component (locate during impl) | Add VLM pill + skipped/error variants | +20 |

Total ≈ 250 LOC, two new files, mostly frontend.

---

## Decisions locked

| Decision | Choice |
|---|---|
| Orchestrator | Frontend (acceptable trade-off: closing tab cancels) |
| Plateau threshold | 3 consecutive 1-second polls with same `event_count` |
| Min ingest wait | `min(15s, duration_s)` |
| Hard cap | `duration_s + 5s` |
| Aggregate endpoint vs FE-stitched | Single `/progress` endpoint (cheaper polling, atomic snapshot) |
| Error UX | Red "Error" pill, no auto-retry |
| VLM disabled UX | Greyed pill with `—`, transition straight to done |
| Re-analyze on existing uploads | Out of scope; flagged as follow-up (would need a button on the detail page) |

---

## Phasing (if shipping in slices)

1. **Slice 1** — backend `/progress` endpoint + tests + a "Re-analyze" button on the detail page that uses it. Validates polling pattern.
2. **Slice 2** — replace upload-page fake timer with real polling, still 4 stages (fold VLM into "Analyze").
3. **Slice 3** — split into the full 5-stage flow with sub-progress.

Single-PR is fine too; the slices exist to de-risk in case the demo timeline tightens.

---

## Out of scope

- Backend orchestrator that survives tab close
- Re-analyze affordance for already-processed uploads (separate detail-page work)
- Real EOS hook from DeepStream into Redis (the right long-term fix; not needed for this slice)
- Persisting in-progress state to localStorage (would let the user reload mid-flow)
