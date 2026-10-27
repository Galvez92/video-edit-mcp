# AGENTS.md — repo memory & rules for coding agents

## What this is
`video-edit-mcp`: an open-source (MIT) MCP server that lets any assistant edit video using ffmpeg.

## Stack
- Node 20+, TypeScript (ESM, `NodeNext`), `@modelcontextprotocol/sdk` + `zod`.
- ffmpeg/ffprobe spawned as child processes (never via a shell; pass args as arrays).
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

## Hard rules
- **No vendor or product names** of any private company/platform in code, docs, commits, or test data. Generic terms only.
- **No secrets**: no API keys, tokens, `.env` files, or private URLs. Everything must run offline/local.
- **No copied private code.** Write fresh, generic code.
- **Tests required** for every new tool (happy path + error path) using synthetic or verified-license media only.
- **No releases, npm publish, or MCP registry submission** without explicit owner approval.

## Memory (update every time)
- `docs/memoria/BITACORA.md` — single append-only log. Add a dated entry (YYYY-MM-DD) per merged change: what, branch, tests.
- `docs/memoria/ramas/<branch>.md` — one ficha per branch. Update its **Status** (pending → in-progress → review → merged) and notes. Do not create other copies.

## Sandbox dev environment (Base44)

`docker-compose.base44.yml` + `Dockerfile.base44` bring the server up for a live preview. Dev-only; CI and releases ignore them.

- `mcp` — the server itself, run from the cloned source with `tsx watch`. The image only supplies the runtime and the system dependency (`ffmpeg`/`ffprobe`, which the server spawns as child processes); the repo is bind-mounted at `/app` and `npm ci` runs at startup against a `node_modules` volume, so no image rebuild is needed after an edit. Listens on `--host 0.0.0.0` (CLI flag; the code default stays `127.0.0.1`).
- `web` — `nginx:alpine` front door on host port 3000. The server has no UI, so it serves `.base44/preview/index.html` (a status page that calls `tools/list` and `health` over the real endpoint) and reverse-proxies `/mcp` to `mcp:3333`, giving MCP clients one origin. The server is also reachable directly on host port 3333.
- No application code or shared config needed a sandbox override, so nothing is gated on `BASE44_PREVIEW_MODE` and no host/Origin allowlist was touched. Neither process checks `Host`, and both bind all interfaces, so the preview proxy works as-is.
- No external services, credentials, or `.env` files: per the hard rules above everything runs offline/local. The compose stack therefore has no secret wiring.

```bash
docker compose -f docker-compose.base44.yml up -d --build   # preview: http://localhost:3000/
docker compose -f docker-compose.base44.yml logs -f mcp      # server log
```

Verify: `GET /` renders the status page with `ffmpeg` reported available; a `tools/list` (or `tools/call`) POST to `/mcp` returns `health` and `probe`, e.g.

```bash
curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
