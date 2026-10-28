# AGENTS.md — repo memory & rules for coding agents

## What this is
`video-edit-mcp`: an open-source (MIT) MCP server that lets any assistant edit video. Two engines:
- **HyperFrames** (Apache-2.0, `@hyperframes/producer`) — PRIMARY engine for animated captions, graphics/overlays and composition (HTML → frames via headless Chrome).
- **ffmpeg** — cut/trim/concat, audio mix/loudnorm, final encode/mux.

## Stack
- Node 22+, TypeScript (ESM, `NodeNext`), `@modelcontextprotocol/sdk` + `zod`.
- ffmpeg/ffprobe spawned as child processes (never via a shell; pass args as arrays).
- HyperFrames: optional peer dependency `@hyperframes/producer` (Node ≥22, pulls puppeteer + headless Chrome). Import it dynamically; if missing, tools report `unavailable` (isError) instead of crashing.
- Tests: vitest. Lint: eslint (flat config). CI: `.github/workflows/ci.yml`.

## Commands
```bash
npm ci                 # install
npm run typecheck      # tsc --noEmit
npm run lint
npm test               # vitest (ffmpeg tests skip if ffmpeg is missing)
npm run build          # -> dist/
npm run fixtures       # synthetic media into tests/fixtures
node dist/index.js             # stdio transport
node dist/index.js --http --port 3333   # Streamable HTTP on /mcp
```

## Layout
- `src/server.ts` — tool registry (`createServer()`); register real tools only.
- `src/transports/{stdio,http}.ts` — transports.
- `src/core/ffmpeg.ts` — `run/ffmpeg/ffprobe/probe/health`.
- `src/core/timeline.ts` — `Timeline/Track/Clip` types and helpers.
- `tests/` — vitest; fixtures are generated at test time with `testsrc`/`sine`.
- `docs/memoria/` — project memory (see below).

## Conventions
- One tool = one zod input schema + JSON text output; errors return `isError: true`, never throw out of a handler.
- Times in seconds (float). Paths are local files; never download media inside tools.
- Do not register placeholder/fake tools. Planned tools live only in `docs/memoria/ramas/*.md`.
- Keep dependencies minimal; no native addons without discussion.

## Branch workflow
- `main` is always green. Work in `feat/<name>`, `chore/<name>`, `docs/<name>`; open a PR to `main`.
- Order: `feat/core-ffmpeg` → (`feat/transcribe`, `feat/captions`, `feat/reframe`, `feat/audio-mix` in parallel) → `feat/render-export` → `feat/interchange` → `docs/readme`. `chore/tests-fixtures` can run anytime.
- No per-branch copies of config (tsconfig, eslint, CI, AGENTS.md). Shared config changes go to `main` first.

## Engine split rules
- Captions, overlays, titles, lower-thirds, compositions → HyperFrames renders the visual layer; ffmpeg muxes/encodes the result with source audio.
- Never reimplement in ASS what HyperFrames covers; SRT/ASS stay as interchange/export formats and an ffmpeg fallback when HyperFrames is unavailable.
- Use HyperFrames only through its public npm API. Keep its Apache-2.0 notice: credit it in README "Third-party" section; do not vendor its source.
- HyperFrames tests skip when the package or Chrome is absent (like ffmpeg tests).

## Hard rules
- **No vendor or product names** of any private company/platform in code, docs, commits, or test data. Generic terms only.
- **No secrets**: no API keys, tokens, `.env` files, or private URLs. Everything must run offline/local.
- **No copied private code.** Write fresh, generic code.
- **Tests required** for every new tool (happy path + error path) using synthetic or verified-license media only.
- **No releases, npm publish, or MCP registry submission** without explicit owner approval.

## Base44 sandbox (dev preview)
- `docker-compose.base44.yml` runs the MCP server from the cloned source: `npm ci` at container start plus `tsx watch` (live reload), published on host port 3000 → container 3333. It is sandbox-only tooling; it does not change app behaviour.
- Nothing else to configure: no secrets, no external services, no database. `.base44/Dockerfile` (sandbox-only, no source baked in) adds ffmpeg/ffprobe on top of `node:22`, so `health` reports both as available.
- The preview iframe shows the MCP endpoint: `GET /` answers 405 by design, the entry point is `POST http://localhost:3000/mcp`.
- Run every check inside the container: `docker compose -f docker-compose.base44.yml exec -T mcp npm run lint|typecheck|test|build`. Tests generate their own synthetic fixtures; `npm run fixtures` writes them to `tests/fixtures` (git-ignored).

## Memory (update every time)
- `docs/memoria/BITACORA.md` — single append-only log. Add a dated entry (YYYY-MM-DD) per merged change: what, branch, tests.
- `docs/memoria/ramas/<branch>.md` — one ficha per branch. Update its **Status** (pending → in-progress → review → merged) and notes. Do not create other copies.
