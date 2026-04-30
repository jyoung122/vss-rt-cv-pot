# V1 Implementation Plan — SSI AIMS

**Goal:** ship the working CV pipeline (formerly `vss-rt-cv-pot`) as **SSI AIMS** — a single-VM demo with a polished SSI-branded UI on top of the working DeepStream perception pipeline.

**Posture:** POT is the app. No auth, no IVM service integration. Upload-only. The IVM repo (`intelligent-video-monitoring/`) is harvested for brand + UI assets, then frozen.

**Prior plan:** [V1_PLAN_INTEGRATION_ARCHIVED.md](V1_PLAN_INTEGRATION_ARCHIVED.md) — abandoned per 2026-04-30 scope reset (auth dropped, IVM service integration dropped).

---

## Locked decisions

| # | Decision |
|---|---|
| D1 | POT is the project. Will be renamed `aims/` (post-Phase 1). |
| D2 | No auth. Public on the demo VM (firewall-restricted by hosting). |
| D3 | No IVM services in v1 (no behavior-analytics, search-store, video-store, alert-verification, agent layer). |
| D4 | Upload-only. RTSP deferred. |
| D5 | UI rebrand under SSI AIMS identity. Lift IVM `apps/ui` design system + page chrome where it improves on POT's. |
| D6 | Always-on GPU VM (Brev / AWS). |
| D7 | TrafficCamNet 4 classes (car, bicycle, person, road_sign) sufficient. |
| D8 | IOU tracker stays. |
| D9 | NGC creds via env file (v1 demo). |
| D10 | `intelligent-video-monitoring/` repo frozen after asset harvest. Not deleted. |

---

## Phases

```
Phase 1  Brand harvest + frontend rebrand    (1 day)
Phase 2  UI improvements (lift IVM shell)    (1–2 days)
Phase 3  Backend hardening for prod-ish      (½ day)
Phase 4  Repo rename: vss-rt-cv-pot → aims   (½ day)
Phase 5  GPU VM deploy + runbook              (½ day)
Phase 6  Demo acceptance                      (½ day)
```

Total: ~3–5 days.

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
2. ⏳ **Dashboard (`/`) — OpsVision palette pass** (~30 min) — quick restyle so the homepage doesn't look mismatched next to the polished `/uploads` pages.
3. ⏸ **Dashboard — full live-ops view from `dashboard.jsx` artboard** (~1 day) — multi-camera grid + live event feed. Strong demo entry point. Defer to v1.1 if time pressure.

**Phase 3 — backend hardening** (~½ day total, all small)
4. ✅ `file-loop=0` set in `deepstream/config/perception-config.txt` (commit `4c5e6da`).
5. ⏳ Healthchecks on `redis`, `postgres`, `backend`, `vss-rt-cv` in `docker-compose.yml`.
6. ⏳ TRT engine cache as a named volume — avoid 3.5min cold builds on container restart.
7. ⏳ Drop `redis-commander` from prod compose.
8. ⏳ `.env.example` updated — `NGC_API_KEY`, `DATA_DIR`, `HOST_IP`, `DATABASE_URL`, `POSTGRES_PASSWORD`.

**Phase 4 — repo rename** (~½ day)
9. ⏳ `git mv vss-rt-cv-pot aims` (one clean commit).
10. ⏳ Update README, compose files, planning doc cross-refs (`MIGRATION_MAP.md`, `V1_PLAN.md`).

**Phase 5 — GPU VM deploy** (~½ day)
11. ✅ Brev GPU VM provisioned (A6000 48 GB, driver 580.126.09, CUDA 13.0). E2E validated 2026-04-30.
12. ⏳ Write `aims/docs/deploy.md` runbook — NGC login, env file, **pre-stage TrafficCamNet ONNX via bearer-token REST** (NGC CLI 403s on signed-URL redirect), **`chmod -R 777 data/models`** (container runs as uid 1000, host dir is host-uid 755), `docker compose up -d`, first-boot TRT cache wait.
13. ⏳ Cold-deploy on a fresh VM to validate the runbook (the 2026-04-30 run validated the *stack*; the *runbook* itself doesn't exist yet).

**Phase 6 — demo acceptance** (~½ day)
14. ⏳ Run the 8 acceptance criteria from the plan against the live VM.
15. ⏳ Capture before/after screenshots for the demo deck.
16. ⏳ Write the demo script (`docs/demo-script.md`) — three sample clips, expected timing, fallback if a stage fails.

### Deferred (not blocking v1 demo)
- ⏸ `/events` global view (cross-upload filtering)
- ⏸ `/settings` page real content
- ⏸ Per-clip thumbnails (`ffprobe -ss` frame extraction)
- ⏸ NvDCF tracker swap (currently IOU)
- ⏸ Behavior-analytics rule retune (whole IVM analytics path was dropped from v1 anyway)
- ⏸ Real Scenarios tab on detail page (VLM/rule-based — v1.5)
- ⏸ S3/MinIO for video bytes (currently local disk — fine for single-VM demo)
- ⏸ Auth (Supabase JWT or simpler) — v1.5 per locked decisions

### Risk watch
- ✅ ~~The full pipeline (DeepStream → indexer → Postgres → UI) has never run together.~~ Validated 2026-04-30 on a Brev A6000: 16,526 events / 70 tracks / 4 classes (car 10,891 · road_sign 2,386 · person 2,204 · bicycle 1,045) on `115_and_HVP.mp4` (148.8 s); `max(t_seconds)=148.67` matched clip duration. API endpoints (`/api/uploads`, `/api/uploads/:id/events?group=tracks`) returned correct shape. Cold-deploy traps catalogued in [`docs/gotchas.md`](docs/gotchas.md).
- TRT engine cold build (~3.5min) is one-time-per-arch — document in `deploy.md` so the first deploy doesn't look broken.
- ✅ ~~ffprobe inside the slim Python image — not yet exercised.~~ Exercised 2026-04-30; parsed 1280×720 @ 15 fps cleanly on upload.

---

## Phase 1 — Brand harvest + frontend rebrand

**Branch:** `feat/aims-rebrand` in `vss-rt-cv-pot/`.

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

4. **README update** — `vss-rt-cv-pot/README.md` gets an "About SSI AIMS" lead paragraph.

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
   - Healthchecks on `redis`, `backend`, `vss-rt-cv`
   - Named volume for TRT engine cache (avoid 3.5min rebuild on container restart)
   - `.env.example` documenting `NGC_API_KEY` and any other required env
3. **Backend** — `backend/app/`:
   - Confirm `/healthz` endpoint exists; add if missing
   - CORS: restrict to deploy origin
   - Drop `redis-commander` from prod compose (dev-only)

### Verification

- `docker compose config` clean
- `docker compose up`, `curl /healthz` returns 200
- Restart `vss-rt-cv` container, second startup <10s (TRT cache warm)
- Upload a clip, verify it processes once (no loop)

**Exit:** compose runs cleanly with hardened defaults.

---

## Phase 4 — Repo rename

**Order matters — do this AFTER Phase 1–3 are merged so the rename is a single clean commit.**

### Tasks

1. `cd /home/jeremy-young/repos/sync && git mv vss-rt-cv-pot aims` (or `mv` if not a git monorepo)
2. Update internal references:
   - `aims/README.md` — title, paths
   - `aims/docker-compose.yml` — service names if they reference the directory
   - `aims/CURRENT_STATE.md`, `FUTURE_STATE.md` — path references
3. Update planning docs at `/home/jeremy-young/repos/sync/`:
   - `MIGRATION_MAP.md` references
   - `V1_PLAN.md` self-references
4. If there's a remote: rename the remote repo too, update git remote URL.

### Verification

- `grep -r "vss-rt-cv-pot\|vss_rt_cv_pot" aims/` returns nothing material
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
   - Verify `curl http://localhost/healthz`
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

**New (in `vss-rt-cv-pot/` → later `aims/`):**
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
