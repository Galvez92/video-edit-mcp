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

## Memory (update every time)
- `docs/memoria/BITACORA.md` — single append-only log. Add a dated entry (YYYY-MM-DD) per merged change: what, branch, tests.
- `docs/memoria/ramas/<branch>.md` — one ficha per branch. Update its **Status** (pending → in-progress → review → merged) and notes. Do not create other copies.

## Dev environment (sandbox)
- `docker-compose.base44.yml` runs the server from this checkout in one service, `mcp`: `npm ci` then `tsx watch src/index.ts --http --port 3000 --host 0.0.0.0`, on `docker/Dockerfile.base44` (plain `node:22` + ffmpeg, no source baked in). The repo is bind-mounted at `/app` and dependencies live in the `node_modules` volume, so edits apply without a rebuild.
- `GET /` serves a small index page (also the compose healthcheck); MCP itself is `POST /mcp`.
- The sandbox host has no Node/ffmpeg of its own — run every check in that container:
  `docker compose -f docker-compose.base44.yml exec -T mcp npm run lint` (same for `typecheck`, `test`, `build`). Re-run `up -d` only when the image or `package-lock.json` changes.
- No secrets are required; everything runs offline/local.
- The image ships no Whisper backend (optional by design): build lint/test green either way, the `transcribe` end-to-end test only runs with `VEM_WHISPER_TESTS=1` plus an installed backend and model, and otherwise skips as "por revisar". It was verified with `pip3 install whisper-ctranslate2` inside the running container (ad hoc, not part of the image; a recreated container loses it). Backend install hints, env vars (`VEM_WHISPER_*`) and the stub used by the tests are documented in `docs/memoria/ramas/feat-transcribe.md`.
