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

## Sandbox environment (Base44 dev stack)
- `docker-compose.base44.yml` + `Dockerfile.base44` run the server from the bind-mounted source in watch mode (`tsx watch src/index.ts --http --port 3000 --host 0.0.0.0`). The image adds only ffmpeg/ffprobe, `fonts-dejavu-core` (needed by libass for caption burn-in) and curl; dependencies are installed on container start and kept in the `mcp-node-modules` volume.
- Host port 3000 is the **Streamable HTTP transport** (`POST /mcp`): this repo is an MCP server, not a web app, so `GET /` answers 404 by design and `/mcp` is the only public route.
- The compose healthcheck probes both critical parts: the ffmpeg binaries and a live `initialize` round-trip against `/mcp`.
- No `BASE44_PREVIEW_MODE` overrides are needed: the transport binds `0.0.0.0` and validates neither `Host` nor `Origin`.
- Run every check inside the container (the sandbox host has no Node): `docker compose -f docker-compose.base44.yml exec -T mcp npm run lint|typecheck|test|build`.
- `@hyperframes/producer` is intentionally **not** installed here (optional peer that pulls puppeteer + Chrome): its tests skip and `captions.render` reports the HyperFrames engine as unavailable, while the `ffmpeg` engine path runs for real.

## Memory (update every time)
- `docs/memoria/BITACORA.md` — single append-only log. Add a dated entry (YYYY-MM-DD) per merged change: what, branch, tests.
- `docs/memoria/ramas/<branch>.md` — one ficha per branch. Update its **Status** (pending → in-progress → review → merged) and notes. Do not create other copies.
