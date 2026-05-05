# Swap Postgres → self-hosted Supabase, add auth

## Context

Today AIMS runs a vanilla `postgres:16-alpine` container and has **no auth at all** — every route on the FastAPI backend and Next.js frontend is public. `docs/v1/plan.md` already locks v1.5 auth to "self-hosted Supabase Auth (OSS GoTrue)" (commit `1cdd974`, 2026-05-05). This change brings that forward: replace the bare Postgres container with the full self-hosted Supabase stack so we get GoTrue (auth) and Studio (ops UI) alongside Postgres in one drop-in compose, then wire single-tenant email+password auth through the frontend and verify Supabase-issued JWTs in FastAPI.

Per user direction: existing data in `uploads` / `events` / `incidents` / `rule_config` is **dropped** — `schema.sql` re-runs against the new DB on first boot.

## Execution model

- **Branch**: cut `feat/supabase-auth` from `main` before any edits.
- **Plan doc in repo**: copy this plan to `docs/v1/phases/supabase-auth.md` and commit on the new branch as the first commit (`docs: plan supabase self-host + auth`). Keeps reviewers oriented and matches the `docs/v1/` convention.
- **Delegated coding**: orchestrator (Opus, this session) stays read-only after planning. Each implementation chunk below is dispatched to a **Sonnet** subagent (or Haiku for the trivial chunks marked H) via the `Agent` tool with `subagent_type: "general-purpose"` and an explicit `model: "sonnet"` / `model: "haiku"` override. Orchestrator only reviews diffs, runs verification, and commits.
- **Subagent briefing rules**: each spawn gets (a) link to this plan file, (b) the exact files it may touch, (c) the shadcn-only directive from `CLAUDE.md`, (d) "no commits, no pushes — leave changes for orchestrator to review and commit". Orchestrator audits the diff before each commit.

### Agent task breakdown

| # | Chunk | Model | Files |
|---|---|---|---|
| 1 | Branch + commit plan doc | H | `docs/v1/phases/supabase-auth.md` |
| 2 | `docker-compose.supabase.yml` (trimmed Supabase stack on `vss-net`) | Sonnet | new file |
| 3 | Remove `postgres` service + `aims-pg-data` from both compose files; update `depends_on` | H | `docker-compose.yml`, `docker-compose.dev.yml` |
| 4 | `.env.example` additions | H | `.env.example` |
| 5 | Backend JWT auth (`backend/app/auth.py` + wire `Depends(require_user)` into router includes; keep `/healthz` open) | Sonnet | `backend/app/auth.py`, `backend/app/main.py`, `backend/requirements.txt` |
| 6 | Frontend Supabase client triple + middleware redirect | Sonnet | `frontend/src/lib/supabase/{client,server,middleware}.ts`, `frontend/src/middleware.ts` |
| 7 | `/login` page (shadcn primitives only) + sign-out control in nav | Sonnet | `frontend/src/app/login/page.tsx`, existing nav file |
| 8 | README bootstrap-operator section + flip plan entry | H | `README.md`, `docs/v1/plan.md` |

## Approach

1. **Add Supabase compose stack** as `docker-compose.supabase.yml` (a layered override file, kept separate so the GPU-heavy `docker-compose.yml` stays focused). Vendor the upstream `supabase/docker` compose and trim to: `db`, `auth` (GoTrue), `studio`, `meta`, `kong`. Skip `rest` (PostgREST), `realtime`, `storage`, `imgproxy`, `edge-runtime`, `vector`, `analytics` — the FastAPI backend already owns the API surface and we don't use storage/realtime.
2. **Remove the old `postgres` service** from `docker-compose.yml` and `docker-compose.dev.yml`. Backend's `DATABASE_URL` repoints to the Supabase `db` service (`postgres://postgres:${POSTGRES_PASSWORD}@db:5432/postgres`). Backend keeps using asyncpg — the Supabase Postgres is just Postgres with extra schemas (`auth`, `storage`).
3. **Apply `schema.sql` into the `public` schema** of Supabase Postgres on backend startup (existing `init_pool` flow already does this — only the connection string changes). Drop the named volume `aims-pg-data`; Supabase uses its own `db-data` volume.
4. **Frontend auth**: install `@supabase/supabase-js` and `@supabase/ssr`. Add a single `/login` page (shadcn `Card` + `Input` + `Button` — no custom HTML), root middleware that redirects unauthenticated users to `/login`, and a sign-out control in the existing nav. JWT lives in an httpOnly cookie via `@supabase/ssr`.
5. **Backend JWT verification**: add `python-jose[cryptography]` to `backend/requirements.txt`. New `backend/app/auth.py` exposes a `require_user` FastAPI dependency that validates the Supabase JWT (HS256, signed with `SUPABASE_JWT_SECRET`) and returns `{user_id, email}`. Wire it into every router via `dependencies=[Depends(require_user)]` on the include in `main.py` — except `/healthz` and `/readyz`.
6. **Bootstrap operator**: one-time SQL seed inserted via `db/seed.sql` (run manually with the documented `curl` against GoTrue admin API or `psql` insert into `auth.users`). Document in README.
7. **Env vars**: add to `.env.example`:
   - `POSTGRES_PASSWORD` (already exists, reused by Supabase db)
   - `JWT_SECRET` (32+ char random; shared by GoTrue and FastAPI)
   - `ANON_KEY`, `SERVICE_ROLE_KEY` (Supabase-issued JWTs derived from `JWT_SECRET`; generate via `supabase/cli` or the documented online tool — README will reference the script)
   - `SITE_URL=http://localhost:3000`
   - `GOTRUE_DISABLE_SIGNUP=true` (single-tenant — operator is provisioned, not self-served)
   - `NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000` (Kong gateway)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=…`

## Files to modify

- `docker-compose.yml` — remove `postgres` service + `aims-pg-data` volume; backend `depends_on` updates to `db` (from supabase compose).
- `docker-compose.dev.yml` — same removal; document `docker compose -f docker-compose.dev.yml -f docker-compose.supabase.yml up`.
- `docker-compose.supabase.yml` *(new)* — trimmed Supabase services on `vss-net` network.
- `.env.example` — new auth/JWT vars.
- `backend/requirements.txt` — add `python-jose[cryptography]>=3.3`.
- `backend/app/auth.py` *(new)* — `require_user` dependency.
- `backend/app/main.py` — wire `Depends(require_user)` into router includes (lines 18–22 area); leave `/healthz`/`/readyz` open.
- `backend/app/db.py` — no code change, just `DATABASE_URL` env reroute.
- `frontend/package.json` — add `@supabase/supabase-js`, `@supabase/ssr`.
- `frontend/src/lib/supabase/client.ts`, `server.ts`, `middleware.ts` *(new)* — standard `@supabase/ssr` triple.
- `frontend/src/middleware.ts` *(new)* — redirect unauthenticated → `/login`.
- `frontend/src/app/login/page.tsx` *(new)* — shadcn-only login form.
- `frontend/src/app/layout.tsx` or existing nav — sign-out button.
- `README.md` — bootstrap operator account steps.
- `docs/v1/plan.md` — flip the v1.5 entry to "in progress" / done.

## Reused existing patterns

- `backend/app/db.py:init_pool()` already runs `schema.sql` at startup — no change needed beyond connection string.
- shadcn primitives (`Card`, `Input`, `Button`, `Form`) already installed — login page uses these per `CLAUDE.md` ("Never add custom `<button>`, `<input>`…").
- Existing CSS vars (`var(--accent-500)`, `var(--fg-1)`) for the login page styling.
- `RequestIdMiddleware` and CORS in `main.py` stay as-is; `require_user` runs *after* them via FastAPI dependency order.

## Verification

1. **Stack up**: `docker compose -f docker-compose.dev.yml -f docker-compose.supabase.yml up -d`. Confirm `db`, `auth`, `kong`, `studio`, `backend` healthy via `docker ps`.
2. **DB schema**: `docker exec -it supabase-db psql -U postgres -c '\dt public.*'` — see `uploads`, `events`, `incidents`, `rule_config`.
3. **Studio**: open `http://localhost:8000` → Supabase Studio loads, auth schema visible.
4. **Provision operator**: run documented `psql` snippet to insert into `auth.users` with bcrypt'd password.
5. **Frontend login**: `npm run dev` in `frontend/`, hit `http://localhost:3000` → redirected to `/login`. Sign in with operator creds → land on dashboard. Network tab: cookie set; subsequent backend calls carry `Authorization: Bearer <jwt>`.
6. **Backend protection**: `curl http://localhost:8080/api/uploads` (no token) → 401. `curl -H "Authorization: Bearer $JWT" …` → 200 with data.
7. **Healthcheck still open**: `curl http://localhost:8080/healthz` → 200 unauthenticated.
8. **Sign out**: cookie cleared, redirected back to `/login`.
9. **Type check + build**: `cd frontend && npm run build` clean. `cd backend && python -m compileall app/`.
10. **Atomic commits**: one `feat(infra): swap to self-hosted supabase stack`, one `feat(auth): backend JWT verification`, one `feat(auth): frontend login + middleware`, one `docs: update plan + readme for supabase auth`.

## Out of scope

- No PostgREST / Storage / Realtime adoption (deferred — backend keeps owning the API).
- No multi-user / RLS / role columns (single-tenant per user direction).
- No magic-link / OAuth / MFA (email+password only).
- No data migration from old `aims-pg-data` volume (user opted to drop).
