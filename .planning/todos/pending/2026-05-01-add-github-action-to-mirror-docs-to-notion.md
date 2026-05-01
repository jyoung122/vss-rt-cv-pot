---
created: 2026-05-01T17:12:50.106Z
title: Add GitHub Action to mirror docs to Notion
area: docs
files:
  - docs/services/
  - V1_PLAN.md
  - docs/deploy/
---

## Problem

Per-service docs now live in `docs/services/*.md` (scaffolded 2026-05-01, commits `e0445fb` + `37d8264`) alongside `V1_PLAN.md` and `docs/deploy/**`. Non-engineering stakeholders need a readable view without cloning the repo or browsing GitHub. In-repo markdown stays the source of truth (PR-reviewable, `git grep`-able), but a Notion mirror would let non-engineers consume it.

## Solution

GitHub Action triggered on push to `main` that mirrors:

- `docs/services/*.md`
- `V1_PLAN.md`
- `docs/deploy/**`

Into a Notion workspace via the Notion API. Notion integration token + parent page ID stored as repo secrets.

**Watch out for:**

1. **Relative repo links won't resolve in Notion** — sync step must rewrite `../V1_PLAN.md`, `./backend.md`, etc. to Notion page links. This is the part most off-the-shelf actions get wrong.
2. **Markdown fidelity gaps** — Notion's API drops or distorts callouts, nested code blocks, complex tables. Treat the mirror as best-effort.
3. **One-way sync** — Notion is a read-only viewer for non-engineers. Reject any PR that tries to edit the mirror back into the repo.

**Candidate tools:**

- [`vorcigernix/notion-github-sync`](https://github.com/marketplace?query=notion) — off-the-shelf marketplace action
- Custom action with `@notionhq/client` — most flexible, handles link rewriting properly
- `markdown-to-notion` — npm package, can wrap in a small custom action

Recommended approach: prototype with `vorcigernix/notion-github-sync` first; fall back to a custom `@notionhq/client` action if link rewriting is broken.
