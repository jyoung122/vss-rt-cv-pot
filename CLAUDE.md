# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) first — that's the canonical agent guide for this repo. The notes below are Claude Code specific.

## Session-specific notes

- The build cache (`frontend/.next`) goes stale after major changes. If you see "Cannot find module for page: /_document", run `rm -rf frontend/.next && cd frontend && npm run build`.
- `next build` reformats `frontend/tsconfig.json` cosmetically. Revert with `git checkout frontend/tsconfig.json` before committing to keep diffs clean.
- Don't commit Python `__pycache__/` from `tools/` — it's in `.gitignore`.
- Don't add backwards-compat shims, feature flags, or "deferred" wiring. The pivot dropped auth, integration, and most v2 hooks. Trust the simplification.

## Workflow

- Atomic commits, conventional style (`feat(scope): …`, `fix(scope): …`, `docs: …`, `style: …`). Existing log shows the convention.
- Before claiming a UI task done: actually load the page, click through the flow, and watch the console. Type-checking ≠ feature correctness.
- For frontend work, `docker-compose.dev.yml up` + `npm run dev` in `frontend/` is the fast loop (HMR). Don't rebuild the frontend Docker image during dev.
- If you spawn agents for sub-tasks, give them the shadcn-only directive explicitly and audit the diff afterward — generic UI prompts produce custom HTML.

## Things to never do

- Never add custom `<button>`, `<input>`, `role="dialog"` etc. when a shadcn primitive exists.
- Never hardcode color hexes in components — use CSS vars (`var(--accent-500)`, `var(--fg-1)`, etc.) or shadcn slot tokens.
- Never run `git add -A` / `git add .` from the repo root — be specific. Avoids picking up `__pycache__`, `.next`, or local `.env`.
- Never bypass commit hooks (`--no-verify`) or signing — fix the underlying issue.
- Never rename container names, volumes, or the repo dir without an explicit Phase-4 ticket — it'll churn the diff across compose files and docs.

## When in doubt

- Check [`docs/V1_PLAN.md`](docs/V1_PLAN.md) for what's done, in flight, and deferred.
- Check [`AGENTS.md`](AGENTS.md) for conventions and repo map.
- Check [`README.md`](README.md) for the user-facing run/setup flow.
