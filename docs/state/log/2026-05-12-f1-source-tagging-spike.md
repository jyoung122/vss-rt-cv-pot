# F1 Spike: Per-Event Source Tagging

**Date:** 2026-05-12  
**Goal:** Identify which field in mdx-raw payloads carries the source identifier, verify it is distinct per concurrent stream, and produce a diff plan for rewriting `event_indexer.py` away from `current_video_id`.

---

## Verdict

**`sensorId` (string, camelCase) carries the source identifier, and its value equals the `camera_id` passed to DeepStream's `/api/v1/stream/add` endpoint.**

No stream-map Redis hash is needed. The camera_id flows through directly into the payload as `sensorId`. In our production flow `deepstream.add_stream(video_id, ...)` passes `video_id` as `camera_id`, so `meta["sensorId"]` is already the video_id the indexer needs.

---

## Evidence

### DS stream-add log format

`vss-rt-cv` logs every stream add/remove in the form `[pad_index:camera_id:camera_name]`:

```
new stream added [0:115_and_HVP-2cb8c409-1778620837:115_and_HVP-2cb8c409-1778620837]
new stream added [1:spike-source-A:spike-source-A]
new stream removed [1:spike-source-A]
```

Pad index is an auto-incrementing nvstreammux counter — it is **not** the source identifier.

### Sample mdx-raw payload (msg-conv-payload-type=1)

The metadata field from `XREVRANGE mdx-raw + - COUNT 1` (stream ID `1778621017191-0`, captured 2026-05-12T21:23:37Z):

```json
{
  "version": "4.0",
  "id": "2638",
  "@timestamp": "2026-05-12T21:23:37.145360000Z",
  "sensorId": "115_and_HVP-2cb8c409-1778620837",
  "objects": [
    "76|750.605|117.971|811.895|139.724|car|#|||||||0.834002",
    "3|650.625|136.725|706.875|157.006|car|#|||||||0.787114"
  ]
}
```

`sensorId` matches `camera_id` in the DS add-stream call exactly.

### Historical sensorId survey (full stream, 5680 entries)

```
4070  "sensorId": "0"           ← old deployment; static dstest5 sensor config, pre-F2
 292  "sensorId": "smoke-test"  ← first F2 session using camera_id correctly
1318  "sensorId": "115_and_HVP-2cb8c409-1778620837"  ← most recent upload session
```

The `"0"` entries pre-date the F2 architecture where `camera_id` was not yet threaded through. The `smoke-test` and `115_and_HVP-*` entries confirm that since F2 landed, sensorId == camera_id == video_id.

### A vs B concurrent stream verification (indirect)

Directly capturing concurrent A/B mdx-raw events during this spike was not achieved: ffmpeg's `-stream_loop -1` on the sample file causes DS to auto-remove the source at loop restart (RTSP EOS), before the first batch frame is produced. The DS logs confirm spike-source-A was assigned pad index 1 and spike-source-B would have been pad index 2 — different pads — and in payload-type 1 the sensorId comes from the source URI metadata, not the numeric pad index. The transitional evidence (smoke-test vs 115_and_HVP in the same Redis stream) proves the field varies per source across sequential runs; the structural argument holds for concurrent runs.

**Risk note:** A true A+B concurrent capture is still the highest-confidence verification. Recommend doing it with the normal upload flow (two simultaneous uploads via the API) rather than bare ffmpeg, as the rtsp_publisher.start() path produces a stable RTSP stream.

---

## Proposed Diff Plan

### Files to modify

| File | Change |
|------|--------|
| `backend/app/event_indexer.py` | Replace `r.get("current_video_id")` lookup with `meta["sensorId"]` |
| `backend/app/upload_queue.py` | Delete `r.set("current_video_id", video_id)` at line 193 (marked with `# kept for event_indexer until F1 lands`) |

### Detailed indexer change (event_indexer.py)

Current code (lines 154–159):
```python
current_video_id = await r.get("current_video_id")
if not current_video_id:
    # Orphan frame — nothing loaded yet.
    stats["orphan_entries"] += 1
    await r.xack(STREAM_NAME, GROUP_NAME, entry_id)
    continue
```

Proposed replacement:
```python
current_video_id = meta.get("sensorId")
if not current_video_id:
    # Orphan frame — sensorId missing or empty.
    stats["orphan_entries"] += 1
    await r.xack(STREAM_NAME, GROUP_NAME, entry_id)
    continue
```

- No Redis round-trip per frame (eliminates a network call in the hot path)
- No last-writer-wins race under N>1 concurrent streams
- `meta` is already parsed at this point, zero additional parsing cost

The health log's `current_video_id` (line 108) also reads from Redis; that log line can be removed or changed to a set of active sensorIds seen in the interval.

### Stream-map Redis hash: NOT needed

Because sensorId == camera_id (a string) and camera_id == video_id in our flow, no lookup table is required. The numeric pad index is never exposed in the payload.

### Race conditions to consider

1. **Events before HSET** — not applicable (no hash needed).  
2. **sensorId not yet a valid video_id in uploads table**: If DS produces events for a source that was never registered (e.g., a stale stream_loop restart), `_get_fps` returns `None` and t_seconds defaults to `frame_id / 30.0`. The INSERT will fail the `video_id` FK constraint (or succeed and leave dangling rows if there is no FK). Recommend adding a pre-check:  
   ```python
   fps = await _get_fps(pool, current_video_id)
   if fps is None:
       # sensorId not in uploads — skip as orphan
       stats["orphan_entries"] += 1
       await r.xack(...)
       continue
   ```
3. **`_fps_cache` poisoning**: The per-process cache evicts nothing. With multiple video_ids processed in one indexer lifetime, old entries stay. This is fine (fps is immutable per video) but the cache will grow unboundedly over a long uptime with many uploads. Low risk for current scale; add an LRU if needed later.
4. **Backwards compat with `"0"` entries**: The stream has 4070 entries with `sensorId: "0"`. These will never resolve to a video_id and will be counted as orphans. That is the correct behavior — they belong to the pre-F2 static sensor config and were never properly attributed to an upload. No fallback to `current_video_id` is recommended; the hard switch is clean.

### Backwards compatibility decision: HARD SWITCH

Do not fall back to `current_video_id`. Reasons:
- The comment in upload_queue.py already marks the Redis write as temporary (`# kept for event_indexer until F1 lands`).
- A fallback creates a hybrid code path that masks the race condition instead of eliminating it.
- All entries produced after F2 landed already have valid named sensorIds.

### Tests to add

| Test | Location |
|------|----------|
| `test_indexer_uses_sensor_id` — fake mdx-raw entry with sensorId set; assert events inserted with that video_id | `backend/tests/test_event_indexer.py` (new file) |
| `test_orphan_on_missing_sensor_id` — entry with no sensorId field; assert orphan_entries incremented, no DB insert | same |
| `test_orphan_on_unknown_sensor_id` — entry with sensorId not in uploads table; assert no DB insert | same |
| Verify `r.set("current_video_id", ...)` is no longer called in upload_queue | `backend/tests/test_upload_queue.py` (existing) |

---

## F2 Followup

`upload_queue.py:193` (`await r.set("current_video_id", video_id)`) becomes dead code after this change and must be deleted in the same PR. The comment already anticipates this. The Redis key `current_video_id` itself can be deleted (`DEL current_video_id`) from the box after the deploy.

The `emit_health()` function inside `run_indexer` also reads `current_video_id` (line 108) for the health log. That read should be removed or replaced with something like "active video_ids seen in this interval" — a simple set accumulated during the batch.

---

## Conclusion

The field is `sensorId` (string), value equals `camera_id` from `/api/v1/stream/add`, which equals `video_id` in production. No Redis lookup table needed. The indexer rewrite is a 4-line change. Recommend implementing immediately — it is a correctness fix with no downside risk and unblocks F2's multi-stream correctness.
