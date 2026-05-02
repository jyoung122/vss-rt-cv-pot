# V1 Implementation Plan — SSI AIMS

**Goal:** ship the working CV pipeline (formerly `vss-rt-cv-pot`, now `aims/`) as **SSI AIMS** — a single-VM demo with a polished SSI-branded UI on top of the working DeepStream perception pipeline.

**Posture:** POT is the app. No auth, no IVM service integration. Upload-only. The IVM repo (`intelligent-video-monitoring/`) is harvested for brand + UI assets, then frozen.

**Prior plan:** the original auth + IVM-integration plan was abandoned per the 2026-04-30 scope reset (auth dropped, IVM service integration dropped).

---

## Locked decisions

| # | Decision |
|---|---|
| D1 | POT is the project. Renamed to `aims/` post-Phase 1 (commit `ce2e906`). |
| D2 | No auth. Public on the demo VM (firewall-restricted by hosting). |
| D3 | No IVM services in v1 (no behavior-analytics, search-store, video-store, alert-verification, agent layer). |
| D4 | Upload-only. RTSP deferred. |
| D5 | UI rebrand under SSI AIMS identity. Lift IVM `apps/ui` design system + page chrome where it improves on POT's. |
| D6 | Always-on GPU VM (Brev / AWS). |
| D7 | TrafficCamNet 4 classes (car, bicycle, person, road_sign) sufficient. |
| D8 | IOU tracker stays. |
| D9 | NGC creds via env file (v1 demo). Same `NGC_CLI_API_KEY` covers DeepStream, TrafficCamNet, and the Cosmos-Reason2-2B NIM image pull. |
| D10 | `intelligent-video-monitoring/` repo frozen after asset harvest. Not deleted. |
| D11 | **Demo punchline = traffic-accident detection.** Behavioral rule pack (track-based) + Cosmos-Reason 2 VLM validation, both in scope for v1. NVIDIA's upstream behavior-analytics microservice is *not* adopted — its incident vocabulary (tripwire/ROI/proximity) doesn't include collisions, and its calibration model doesn't apply to upload clips. Custom worker writes to a new `incidents` table; output schema mirrors `mdx-incidents` shape so a future swap is non-disruptive. |
| D12 | **Cosmos-Reason2-2B self-hosted on the demo GPU via NIM.** Image: `nvcr.io/nim/nvidia/cosmos-reason2-2b:latest`. Pulled at deploy time with `NGC_CLI_API_KEY`. Exposes its endpoint on `vss-net`; backend reaches it as `http://cosmos:<port>/v1` (port + exact API shape confirmed in spike #24). Clip handoff via shared `${DATA_DIR}/incidents` volume (read-only into the Cosmos container) when the API supports a file path; multipart upload otherwise. |
| D13 | **GPU plan.** Phase A (rule-only incidents) ships on the current A6000 48 GB. Phase B (Cosmos-Reason2-2B validation) **also fits comfortably on the A6000** — 2B params is well under the 48 GB budget alongside DeepStream's ~3 GB, so dev can proceed without GPU upgrade. Upgrade to **RTX 6000 Pro Blackwell 96 GB** or **L40S 48 GB** is no longer gated by VRAM; it's a perf/headroom decision and remains an hours-not-days Brev provision when needed for the demo. |

---

## Services

Per-service reference docs — config, runbooks, known issues:

| Service | File |
|---|---|
| Frontend (Next.js) | [services/frontend/](services/frontend/README.md) |
| Backend (FastAPI) | [services/backend/](services/backend/README.md) |
| DeepStream (vss-rt-cv) | [services/deepstream/](services/deepstream/README.md) |
| Cosmos-Reason2-2B (VLM) | [services/cosmos/](services/cosmos/README.md) |
| Postgres | [services/postgres/](services/postgres/README.md) |
| Redis | [services/redis/](services/redis/README.md) |
| NVStreamer | [services/nvstreamer/](services/nvstreamer/README.md) |
| SDR | [services/sdr/](services/sdr/README.md) |
| Observability (Loki/Grafana) | [services/observability/](services/observability/README.md) |

---

## Phases

```
Phase 1  Brand harvest + frontend rebrand          (1 day)         ✅
Phase 2  UI improvements (lift IVM shell)          (1–2 days)      ✅
Phase 3  Backend hardening for prod-ish            (½ day)      🔥 (TRT cache volume #6 deferred)
Phase 4  Repo rename: vss-rt-cv-pot → aims         (½ day)      ✅
Phase 5  GPU VM deploy + runbook                    (½ day)
Phase 6  Demo acceptance                            (½ day)
Phase 7  Incident detection — rules (Phase A)      (1½ days)    ✅
Phase 8  Cosmos-Reason 2 validation (Phase B)      (2½ days)    ✅
Phase 9  Support/dev observability v0              (½ day)      ✅
Phase 7/8 follow-on — incidents UX polish          (½ day)      ✅
Phase 10 Product tour (in-app guided walkthrough)   (½ day)      ✅ (verify-on-live #43 outstanding)
```

Total: ~8–10 days.

---

## V1 burn list

What we're actually working on now, in order. Tick as we go.

**Status legend:** ✅ done · 🔥 in flight · ⏳ next · ⏸ deferred

### Shipped beyond original Phase 2 scope
- ✅ Tailwind v3 → v4 migration
- ✅ shadcn-style design system lifted from IVM (`src/components/ui/`)
- ✅ Sidebar shell + multi-route layout (`/`, `/uploads`, `/events`, `/settings`)
- ✅ OpsVision palette, fonts (Inter / Space Grotesk / JetBrains Mono), token system
- ✅ `/uploads` list page rebuilt from OpsVision design (drag-drop, prompt textarea, active-upload card, history table)
- ✅ `/uploads/[video_id]` detail page from OpsVision design (player, scrubber with track bands, prompt recap, selected-track summary, Events/Scenarios tabs)
- ✅ Dashboard (`/`) rebuilt as OpsVision analytics overview — real Uploads-backed KPIs + polished demo-data placeholders for unavailable analytics modules
- ✅ Postgres-backed backend (uploads + events tables, schema.sql, asyncpg)
- ✅ Per-run unique `video_id` (file collision-safe)
- ✅ ffprobe metadata extraction (duration / resolution / fps)
- ✅ Server-side prompt persistence
- ✅ Event indexer (Redis mdx-raw → consumer-group XREADGROUP → Postgres `events`)
- ✅ Endpoints: `GET/DELETE /api/uploads/:id`, `GET /api/uploads/:id/events?group=tracks|none`
- ✅ shadcn-only UI directive enforced (`Button`, `Dialog`, `Badge`, `Card`, `Tabs`, `Tooltip`, `Skeleton`)
- ✅ `docker-compose.dev.yml` — backend without GPU stack (redis + postgres + backend only)

### Burn list (in priority order)

**Risk reduction**
1. ✅ **Synthetic mdx-raw publisher** — `tools/synthetic_mdx_publisher.py` XADDs realistic frames to Redis (13-part DeepStream object format, multi-track lifecycle with motion). `--ensure-upload` stubs a Postgres uploads row for end-to-end detail-page testing without going through the UI. Catches indexer parsing / fps math / scrubber alignment bugs locally before paying GPU time.

**UI polish**
2. ✅ **Dashboard (`/`) — OpsVision analytics overview** — rebuilt homepage from the provided reporting-dashboard artboard. Uses real `GET /api/uploads` data for upload count, indexed events, tracks, analyzed duration, latest upload, and recent upload links; unavailable analytics modules are mocked as restrained "demo data" components. Frontend-only; shadcn primitives only; verified with `cd frontend && npm run build`. Commit `ffe5a9d`.
3. ⏸ **Dashboard — full live-ops view** (~1 day) — true multi-camera grid + live event feed remains deferred to v1.1. The provided `dashboard.jsx` reference was the analytics/reporting view, not the live-ops view.

**Phase 3 — backend hardening** (~½ day total, all small)
4. ✅ `file-loop=0` set in `deepstream/config/perception-config.txt` (commit `4c5e6da`).
5. ✅ Healthchecks on `redis`, `postgres`, `backend`, `vss-rt-cv` in `docker-compose.yml`; backend now serves `/healthz` and keeps `/health` as an alias. Verified with `docker compose config`, `python3 -m compileall backend/app`, and `git diff --check`.
6. ⏸ TRT engine cache as a named volume — removes the `chmod -R 777 data/models` deploy step; day-2 ergonomics, not blocking v1 demo.
7. ✅ Drop `redis-commander` from prod compose.
8. ✅ `.env.example` updated — `NGC_CLI_API_KEY`, `DATA_DIR`, `HOST_IP`, `DATABASE_URL`, `POSTGRES_PASSWORD`.

**Phase 4 — repo rename** (~½ day)
9. ✅ `git mv vss-rt-cv-pot aims` (one clean commit). Done — see commit in Phase 4.
10. ✅ Update README, compose files, planning doc cross-refs (`MIGRATION_MAP.md`, `V1_PLAN.md`). Done in same commit.

**Phase 5 — GPU VM deploy** (~½ day)
11. ✅ Brev GPU VM provisioned (A6000 48 GB, driver 580.126.09, CUDA 13.0). E2E validated 2026-04-30.
12. ✅ Runbook at `deploy/deploy.md` + companion `deploy/reverse-proxy.md` — NGC login, env file, **pre-stage TrafficCamNet ONNX via bearer-token REST** (NGC CLI 403s on signed-URL redirect), **`chmod -R 777 data/models`** (container runs as uid 1000, host dir is host-uid 755), `docker compose up -d`, first-boot TRT cache wait. Move + reverse-proxy guide landed in commit `014316e`.
13. ⏳ Cold-deploy on a fresh VM to validate the runbook (the 2026-04-30 run validated the *stack*; the *runbook* itself isn't committed yet).

**Phase 6 — demo acceptance** (~½ day)
14. ⏳ Run the 8 acceptance criteria from the plan against the live VM.
15. ⏳ Capture before/after screenshots for the demo deck.
16. ⏳ Write the demo script (`docs/demo-script.md`) — three sample clips, expected timing, fallback if a stage fails.

**Phase 7 — Incident detection, rules (Phase A)** (~1½ days)

Rule-only worker that reads the existing `events` table, runs accident heuristics in pixel/track space, and writes to a new `incidents` table. Demo-viable on the A6000 alone. Output schema mirrors `mdx-incidents` so Cosmos can layer on top without a migration.

17. ✅ `incidents` table added to `backend/app/schema.sql` with the spec columns plus a `(video_id, rule_id, t_start_s, track_ids)` unique dedup index. Commit `a1c9232`.
18. ✅ Rule worker `backend/app/incident_worker.py` — bisect-windowed per-track signals + pairwise IOU/proximity/co-stop. All four rules implemented; ON CONFLICT upsert keyed on the dedup index so Phase 8 vlm_* columns will survive re-analyze. Triggered via `POST /api/uploads/:id/analyze` (event-indexer end-of-stream auto-trigger deferred to a follow-up). Commit `a1c9232`.
19. ✅ API: `GET /api/uploads/:id/incidents` and `POST /api/uploads/:id/analyze` in `backend/app/incidents.py`. JSONB columns decoded to dict via `_jsonb()` helper; future cleanup is a `set_type_codec` on pool init. Commit `a1c9232`.
20. ✅ Scenarios tab rewired to `GET /api/uploads/:id/incidents`. Cards use `Card`/`Badge`/`Button`/`Skeleton`/`Tooltip`; severity → CSS-var color (`--danger-500` / `--warn-500` / `--ink-400`); "Jump to" seek + track chips link back to Events. Tab trigger shows count badge. Commit `01ce518`.
21. ✅ Scrubber band layer — thin severity-coloured bands above the existing track bands; click-to-seek; tooltip with rule label + time range. Commit `01ce518`.
22. ✅ Dashboard KPI: "Incidents flagged" tile alongside the existing analytics overview. Counts summed client-side across uploads in v1 (small N); a `GET /api/incidents/count` aggregate would be a one-liner swap later. Commit `01ce518`.
23. ✅ `tools/synthetic_mdx_publisher.py --scenario collision` scripts a two-vehicle collision (IOU peak ≈ 0.38). Module made test-importable via lazy redis/asyncpg imports. Backend unit tests in `backend/tests/test_incident_worker.py` (4/4 passing) verify rule firing, class-name normalization, and stale-row cleanup. Commit `a1c9232`.

**Phase 8 — Cosmos-Reason2-2B VLM validation (Phase B)** (~2½ days)

Self-hosted `nvcr.io/nim/nvidia/cosmos-reason2-2b:latest` confirms / rejects / refines rule-detected incidents. Each incident gets a second pass; the UI shows both signals; the demo headline is "VLM-confirmed incidents." Fits on A6000 alongside DeepStream — no GPU upgrade required to start.

24. ⏭️ **Spike skipped** — went straight to implementation (#25–30). All tests passed; spike doc not produced.
25. ✅ `incidents.vlm_*` columns: `vlm_status`, `vlm_verdict`, `vlm_reasoning`, `vlm_confidence`, `vlm_model`, `vlm_clip_path`, `vlm_latency_ms`, `vlm_at`. Partial index on `vlm_status='pending'`. Added via `ALTER TABLE IF NOT EXISTS` so existing rows get defaults.
26. ✅ `cosmos` service in `docker-compose.yml` — `image: nvcr.io/nim/nvidia/cosmos-reason2-2b:latest`, GPU 0 reservation, `NGC_CLI_API_KEY` env, `aims-cosmos-cache` named volume, `ro` video mount, 10m healthcheck `start_period`.
27. ✅ VLM validator worker `backend/app/vlm_validator.py` — finds pending incidents, extracts clip via ffmpeg, calls Cosmos `/v1/chat/completions` with base64 video + structured prompt, strips `<think>` tags, parses JSON verdict, writes back. `VLM_ENABLED=false` → `vlm_status='skipped'` in one UPDATE. Spawned as `asyncio.create_task` from the analyze endpoint.
28. ✅ UI: VLM pill on each incident card (`Confirmed` / `Rejected` / `Uncertain` / `Pending` / `Error`), expandable "Why" panel with reasoning + model + latency, filter chips (`All` / `Confirmed` / `Rejected` / `Pending`) at top of Scenarios tab.
29. ✅ Dashboard KPI split: `Rule-detected` vs `VLM-confirmed` (by Cosmos-Reason2).
30. ✅ `deploy/deploy.md` + `gotchas.md` — Cosmos cold-start (10–15 min first boot, ~60 s after cache), GPU co-residency (~9 GB combined on A6000), `VLM_ENABLED=false` skip path, `--scale cosmos=0` escape hatch.

**Phase 9 — Support/dev observability v0** (~½ day)

Structured stdout logs and an optional OSS log UI for support/dev debugging. Scope is intentionally not operator status, SRE alerting, or auditor-grade indexing.

31. ✅ Backend logging envelope — `LOG_LEVEL` + `LOG_FORMAT=text|json`, OpenTelemetry-friendly JSON Lines (`ts`/`timestamp`, `level`/`severity_text`, `service`/`service.name`, `logger`/`logger.name`, `msg`/`body`) plus `video_id`, `run_id`, `request_id`, durations, counts, lag, and `exc_info`. Existing `print(...)` paths replaced with level-disciplined logs across startup, upload, Redis, WebSocket, event indexer, incident analysis, SDR, and VLM paths.
32. ✅ Correlation + consumer health — request-id middleware, per-run IDs for upload/analyze flows, context propagation into background work, and periodic `event_indexer.consumer.health` summaries with entries read, rows inserted, malformed objects, current `video_id`, stream lag, and interval duration. Per-frame detail remains DEBUG-only.
33. ✅ TypeScript parity + local log UI — `frontend/src/lib/logger.ts` uses the same envelope and env knobs; upload/WebSocket/proxy console calls routed through it. Added optional `docker-compose.observability.yml` with Loki + Promtail + Grafana, low-cardinality labels only (`service`, `env`, `level`, `logger`), a provisioned Loki datasource, and **AIMS Support/Dev Logs** dashboard on Grafana port `3002`. Verified Loki ingestion for `service=aims-backend`.

**Phase 7/8 follow-on — incidents UX polish** (post-merge, ~½ day)

34. ✅ `/incidents` catalog page + `GET /api/incidents/catalog` endpoint — cross-upload incident browser surfaced in sidebar nav. Commit `8a5fa13`.
35. ✅ Live-editable rule thresholds on the incidents configuration page. Commit `4219fd0`.
36. ✅ Strip per-track tracking data from incidents page — pure rule-config view, no live state leakage. Commit `642e421`.
37. ✅ `incident_worker` mass-stop tuning + stale-incident cleanup fix. Commit `7e95b2a`.
38. ✅ Incident click on uploads detail seeks to incident time and selects first track. Commit `10b4a3d`.

**Phase 10 — Product tour (in-app guided walkthrough)** (~½ day)

First-run guided walkthrough so a stakeholder can self-serve the demo: Dashboard → Uploads → detail page (Events / Scenarios / scrubber bands) → Incidents catalog. Library: **[driver.js](https://driverjs.com/)** (MIT, ~5 KB, framework-agnostic, themable via CSS so it inherits our shadcn / OpsVision tokens). Alternatives considered: `react-joyride` (heavier, opinionated React state), `shepherd.js` (Popper-heavy), `onborda` (Next.js-native but young). driver.js wins on size + zero React coupling for our static-first marketing-style tour.

39. ✅ `driver.js` added to `frontend/package.json`; `frontend/src/lib/tour.ts` exposes `startTour(navigate)` / `resumeTourIfNeeded(page, navigate)` with a typed step registry keyed by `TourPage`. Commit `84258bf`.
40. ✅ Theme overrides for the popover land in `frontend/src/app/globals.css` under `.aims-tour-popover` — background/border/text/buttons resolve via `--bg-*` / `--fg-*` / `--accent-*` so light + dark both work without hex.
41. ✅ Step content covers sidebar orientation, Dashboard (KPIs, VLM-confirmed split, trends, breakdowns, heatmap, recent uploads), Uploads list, upload detail (scrubber, Events tab, Scenarios tab), and Incidents catalog. Cross-page transitions rehydrate via `localStorage` progress + `resolvePagePath` (resolves `/uploads/[id]` from the most recent upload).
42. ✅ "Tour seen" persisted in `localStorage` under `aims:tour:v1`; auto-launch on first dashboard visit + manual "Take the tour" entry in the header next to the theme toggle (`frontend/src/components/app-header.tsx`).
43. ⏳ Verify the tour on a fresh browser profile against the live A6000 deploy — every selector resolves, no scroll traps, console clean.

### Shipped post-Phase 10 (not originally scoped)
- ✅ `/events` global cross-upload view with animated event detail page (shared SVG camera scenes, bounding-box overlay scrubber, AI summary panel, dispatch/export side panel). Commits `3354cc4`, `ddd42dd`.
- ✅ `/live` page using shared `camera-scenes.tsx` dispatcher (extracted from events detail).
- ✅ `/rules` Rule Builder page — camera selection + detection rule configuration UI. Commit `ddd42dd`.
- ✅ `scripts/dev-up.sh` — clean dev-environment bring-up (avoids container-name collisions). Commit `ddd42dd`.
- ✅ Backend `app/incidents.py` + `app/seed.py` + `entrypoint.sh` + `seed-videos/` — seed flow for demo data. Commit `ddd42dd`.
- ✅ Per-service docs scaffolded under `docs/v1/services/**` (frontend, backend, deepstream, cosmos, postgres, redis, nvstreamer, sdr, observability) and architecture overview at `docs/v1/architecture.md`.

### Deferred (not blocking v1 demo)
- ⏸ `/settings` page real content
- ⏸ Per-clip thumbnails (`ffprobe -ss` frame extraction)
- ⏸ NvDCF tracker swap (currently IOU) — would reduce track-ID swap false positives in the rule pack
- ⏸ S3/MinIO for video bytes (currently local disk — fine for single-VM demo)
- ⏸ Auth (Supabase JWT or simpler) — v1.5 per locked decisions
- ⏸ Live (non-batch) incident detection on RTSP streams — current design is per-upload batch
- ⏸ GDINO open-vocab detection driven by the upload-page prompt textarea — v1.5
- ⏸ Operator-facing `/status` UI for "Did my upload process? Why did it fail?" — separate from support/dev logs
- ⏸ SRE metrics/alerts and auditor-grade OpenSearch/Elasticsearch indexing — observability backlog, not v0 logs

### Risk watch
- ✅ ~~The full pipeline (DeepStream → indexer → Postgres → UI) has never run together.~~ Validated 2026-04-30 on a Brev A6000: 16,526 events / 70 tracks / 4 classes (car 10,891 · road_sign 2,386 · person 2,204 · bicycle 1,045) on `115_and_HVP.mp4` (148.8 s); `max(t_seconds)=148.67` matched clip duration. API endpoints (`/api/uploads`, `/api/uploads/:id/events?group=tracks`) returned correct shape. Cold-deploy traps catalogued in [`gotchas.md`](gotchas.md).
- TRT engine cold build (~3.5min) is one-time-per-arch — document in `deploy.md` so the first deploy doesn't look broken.
- ✅ ~~ffprobe inside the slim Python image — not yet exercised.~~ Exercised 2026-04-30; parsed 1280×720 @ 15 fps cleanly on upload.
- **Rule-pack false positives** — IOU tracker drops/swaps during occlusion will look like collisions. Mitigation: require sustained overlap (≥3 frames) + co-stop, not overlap alone. NvDCF swap is the v1.5 fix.
- **Pixel-space units** — without per-clip calibration, velocity is in px/s and depends on camera angle. Thresholds will need per-clip tuning during demo prep. Document as a known limitation.
- **VLM hallucination** — Cosmos may confidently confirm incidents that didn't happen. Combined-confidence formula caps the VLM contribution and the UI always renders rule confidence alongside the VLM pill — never let VLM-only verdicts present without rule context.
- **GPU co-residency (Phase 8)** — DeepStream + Cosmos-Reason2-2B sharing GPU 0 on A6000 48 GB. 2B at BF16 ≈ 4–6 GB plus KV cache; DeepStream ≈ 3 GB; comfortable headroom. Confirm steady-state VRAM peak in the spike (#24). A6000 is Ampere; NVIDIA lists Hopper/Blackwell as tested platforms — Ampere support is the spike's primary risk to confirm before committing.
- **Cosmos cold start** — multi-minute weight load on container start; healthcheck `start_period` must reflect this. Cache volume keeps subsequent restarts fast.

---

## Phase 1 — Brand harvest + frontend rebrand

**Branch:** `feat/aims-rebrand` in `aims/` (formerly `vss-rt-cv-pot/`).

### Tasks

1. **Brand asset harvest** — copy from IVM (read-only) into POT `frontend/public/brand/`:
   - `intelligent-video-monitoring/SSI Logo - New.jpg` → `frontend/public/brand/ssi-logo.jpg`
   - `intelligent-video-monitoring/fav-Icon.png` → `frontend/public/brand/favicon.png` (and copy to `frontend/src/app/favicon.ico` if Next.js prefers it there)
   - `intelligent-video-monitoring/Home-banner.webp` → `frontend/public/brand/banner.webp`

2. **App identity swap** in `frontend/src/app/layout.tsx`:
   - `title: 'SSI AIMS — AI Monitoring System'`
   - `description: 'SSI AIMS — real-time computer vision monitoring'`
   - Favicon link

3. **Header / chrome** in `frontend/src/app/page.tsx`:
   - Add SSI logo + "AIMS" wordmark in a top header
   - Apply IVM tailwind palette (extracted from `apps/ui/apps/web/app/globals.css` if present)

4. **README update** — `aims/README.md` gets an "About SSI AIMS" lead paragraph.

### Tests / verification

- `cd frontend && npm run build` succeeds
- `npm run dev` — visit `localhost:3000`, see SSI logo, "AIMS" title in tab, branded header
- No console errors

**Exit:** branch has one commit "feat(frontend): rebrand POT under SSI AIMS identity"

---

## Phase 2 — UI improvements (lift IVM shell)

**Goal:** POT frontend goes from "demo single-page" to "real-product feel" by adopting IVM's design system and chrome — minus auth and minus data plumbing we don't have.

### Source map (IVM → POT)

| IVM | Lift to POT | Notes |
|---|---|---|
| `apps/ui/packages/ui/src/components/` | `frontend/src/components/ui/` | shadcn-style primitives (button, card, dialog, etc.) |
| `apps/ui/packages/ui/src/styles/` | `frontend/src/styles/` | global tokens, typography |
| `apps/ui/apps/web/app/app/layout.tsx` | adapt to `frontend/src/app/layout.tsx` | sidebar nav + header chrome; strip auth checks |
| `apps/ui/apps/web/app/app/uploads/` | new route `frontend/src/app/uploads/` | upload list + detail view; rewire to POT API |
| `apps/ui/apps/web/app/app/events/` | optional new route `frontend/src/app/events/` | live event log; rewire to POT WS |
| `apps/ui/apps/web/components.json` | `frontend/components.json` | shadcn config |

### Tasks

1. **Pre-lift spike** (read, don't write):
   - Read `apps/ui/apps/web/app/app/layout.tsx`, `uploads/page.tsx`, `events/page.tsx`
   - Identify auth dependencies (Supabase clients, JWT, RBAC guards) — these get stripped, not ported
   - Identify API call shapes — these get rewired to POT's backend (`/api/upload`, `/ws`, etc.)
   - Document delta in branch commit message

2. **Lift design system:**
   - Copy `packages/ui/src/components/` and styles into POT
   - Install missing deps in POT's `package.json` (likely: `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`)
   - Tailwind config merge: bring IVM's color/typography tokens

3. **Lift app chrome:**
   - Sidebar with nav: **Dashboard / Uploads / Events / Settings** (Streams/Alerts/Analytics/Agent disabled or hidden — they're v2)
   - Header with SSI logo + AIMS wordmark
   - Strip all auth wiring

4. **Rewire data:**
   - Upload page → POT backend's existing upload endpoint
   - Events page → POT backend's `/ws` (existing Redis→WS bridge)
   - Mock empty state for routes we don't have data for yet

### Verification

- All four nav routes load without errors
- Upload from new UI works end-to-end against POT backend
- Live event feed renders bbox overlay (existing component) integrated into the new shell

**Exit:** branch has commits per IVM section lifted; demo flow on `localhost:3000` looks like a real product.

---

## Phase 3 — Backend hardening for prod-ish

### Tasks

1. **DeepStream config** — `deepstream/config/perception-config.txt`: set `file-loop=0` so uploaded clips end cleanly instead of looping.
2. **Compose hardening** — `docker-compose.yml`:
   - `restart: unless-stopped` on all long-running services
   - ✅ Healthchecks on `redis`, `postgres`, `backend`, `vss-rt-cv`
   - ✅ Health-aware `depends_on` ordering for Redis/Postgres/backend dependencies
   - Named volume for TRT engine cache (avoid 3.5min rebuild on container restart)
   - `.env.example` documenting `NGC_API_KEY` and any other required env
3. **Backend** — `backend/app/`:
   - ✅ Confirm `/healthz` endpoint exists; `/health` remains as a compatibility alias
   - CORS: restrict to deploy origin
   - Drop `redis-commander` from prod compose (dev-only)

### Verification

- `docker compose config` clean
- `docker compose up`, `curl http://localhost:8080/healthz` returns 200
- Restart `vss-rt-cv` container, second startup <10s (TRT cache warm)
- Upload a clip, verify it processes once (no loop)

**Exit:** compose runs cleanly with hardened defaults.

---

## Phase 4 — Repo rename

**Order matters — do this AFTER Phase 1–3 are merged so the rename is a single clean commit.**

### Tasks

1. ✅ `mv /home/jeremy-young/repos/sync/vss-rt-cv-pot /home/jeremy-young/repos/sync/aims` — done (`sync/` is not a git monorepo; `mv` was used)
2. Update internal references:
   - `aims/README.md` — title, paths
   - `aims/docker-compose.yml` — service names if they reference the directory
   - `aims/CURRENT_STATE.md`, `FUTURE_STATE.md` — path references
3. Update planning docs at `/home/jeremy-young/repos/sync/`:
   - `MIGRATION_MAP.md` references
   - `V1_PLAN.md` self-references
4. If there's a remote: rename the remote repo too, update git remote URL.

### Verification

- ✅ `grep -r "vss-rt-cv-pot\|vss_rt_cv_pot" aims/` returns nothing material — verified post-rename
- `docker compose up` from new path still works

**Exit:** project is `aims/` everywhere.

---

## Phase 5 — GPU VM deploy + runbook

### Tasks

1. **Provision** — Brev (recommended) or AWS:
   - Brev: GPU template, Ampere+ (A10G or better), Ubuntu 22.04, NVIDIA driver 580+
   - AWS: g5.xlarge or g6.xlarge, NVIDIA Deep Learning AMI
2. **Bootstrap** — `aims/docs/deploy.md` runbook:
   - Install docker + NVIDIA Container Toolkit
   - `docker login nvcr.io` with NGC API key
   - `git clone <aims repo>`, `cp .env.example .env`, fill in secrets
   - `docker compose up -d`
   - Wait for first TRT engine build (~3.5min, one-time)
   - Verify `curl http://localhost:8080/healthz`
3. **First-run smoke** — upload a sample clip via the deployed UI, confirm bbox overlay + event feed populate.

### Verification

- Runbook executed cold on a fresh VM produces a working AIMS in <30 minutes
- Demo URL accessible

**Exit:** documented runbook works end-to-end.

---

## Phase 6 — Demo acceptance

### Acceptance criteria

| # | Criterion | How |
|---|---|---|
| A1 | Operator opens AIMS URL, sees SSI-branded landing | Manual |
| A2 | Upload an MP4 from the UI | Manual |
| A3 | Within 30s of upload, bbox overlay renders detections on the player | UI inspection |
| A4 | Event feed shows detections grouped by track | UI inspection |
| A5 | Process completes (no infinite loop) | UI status indicator |
| A6 | Reset / re-upload works | Manual |
| A7 | Single `docker compose up` brings everything up on Brev VM | Runbook |
| A8 | Branding is consistent — SSI logo, AIMS title, no "POT" / "VSS RT-CV" / Anthropic / Claude leakage | Visual sweep |

### Demo script

1. Open AIMS URL.
2. Click Upload → pick `traffic-clip-1.mp4`.
3. Watch the upload card transition: uploading → processing → complete.
4. Player loads with bboxes drawn live on each frame.
5. Event feed on the right shows detections accumulating by track id.
6. Hit Reset, upload `traffic-clip-2.mp4` — same flow.

**Exit:** all 8 criteria met on a fresh Brev VM.

---

## Out of scope (deferred)

- **v1.5:** auth (Supabase JWT or simpler), upload history (Postgres), saved searches
- **v2:** RTSP streaming via MediaMTX, multi-camera, behavior-analytics rules, ES detection search
- **v3:** Alert verification (VLM), agent layer

These come back as separate projects, harvesting from the frozen `intelligent-video-monitoring/` repo as needed.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| IVM design system has hidden dependencies on auth context | Medium | Phase 2 spike identifies these before lifting; replace with no-op providers |
| Tailwind/component naming collides between POT and IVM | Low | Lift into `components/ui/` namespace; merge tailwind config carefully |
| TRT engine cold build (3.5min) feels broken on first deploy | Low | Document explicitly in deploy runbook + show a "warming up" state in UI |
| nvcr.io auth flake on Brev | Low | Document `docker login nvcr.io` as runbook step |
| Repo rename breaks an external reference (CI, deploy script) | Low | Do rename in a single commit; grep for stragglers |

---

## File-level change summary

**New (in `aims/`, formerly `vss-rt-cv-pot/`):**
- `frontend/public/brand/` — SSI assets
- `frontend/src/components/ui/` — lifted design system
- `frontend/src/styles/` — lifted tokens
- `frontend/src/app/uploads/` — lifted upload page
- `frontend/src/app/events/` — lifted events page (optional)
- `docs/deploy.md` — GPU VM runbook

**Modified:**
- `frontend/src/app/layout.tsx` — title, chrome, header
- `frontend/src/app/page.tsx` — sidebar/nav shell
- `frontend/package.json` — new deps
- `frontend/tailwind.config.js` — merged IVM tokens
- `deepstream/config/perception-config.txt` — `file-loop=0`
- `docker-compose.yml` — hardening
- `.env.example`
- `README.md` — "SSI AIMS" identity

**Frozen (not modified):**
- `intelligent-video-monitoring/` — read-only harvest source for Phase 1 + 2
