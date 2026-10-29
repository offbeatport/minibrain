# Minibrain

Repo rules on top of `~/Development/CLAUDE.md`.

## Plan

- `ROADMAP.md` is the technical plan. Read it before implementing; treat it as settled unless the user changes it.
- This repo is public. Business content (customers, pricing, design partners, investors, license strategy) lives in
  the private repo at `~/Development/private/minibrain_plan.md` and never lands here.

## Portfolio deviations

- Python backend. The frontend is a Vite SPA served by FastAPI, not TanStack Start.
- No better-auth (TypeScript-only).
- No outbound telemetry, ever: the product runs air-gapped. obp-base OpenPanel and Sentry stay off by default or point
  at self-hosted instances.
- TypeScript API client generated from FastAPI's OpenAPI schema.
- obp-ui theme: own `--primary` or a preset, so the `shell` + `console` archetype does not read as cslopslop.
