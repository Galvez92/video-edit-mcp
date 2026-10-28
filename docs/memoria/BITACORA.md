# Bitácora (log único)

Formato: `## YYYY-MM-DD — rama — resumen` + detalles (qué, tests, pendientes). Solo se agrega al final.

## 2026-10-27 — main — esqueleto inicial
- Servidor MCP TypeScript (ESM, Node 20+) con transportes stdio y Streamable HTTP (`--http --port`).
- Tools implementadas: `health` (disponibilidad de ffmpeg/ffprobe) y `probe` (ffprobe normalizado).
- `core/ffmpeg.ts`, `core/timeline.ts` (tipos Timeline/Track/Clip).
- Tests vitest: listado de tools, health, probe sobre fixture generado (testsrc + sine), timeline. Se saltan si no hay ffmpeg.
- CI GitHub Actions (ffmpeg + npm ci + lint + typecheck + test + build).
- Fichas creadas en `docs/memoria/ramas/` para las 9 ramas planeadas (todas `pending`).

## 2026-10-27 — docs/hyperframes-engine — HyperFrames como motor principal
- Decisión del owner: HyperFrames (Apache-2.0, npm `hyperframes` / `@hyperframes/producer` 0.8.209, repo heygen-com/hyperframes) es el motor principal de subtítulos animados, gráficos/overlays y composición. ffmpeg queda para cut/trim/concat, mezcla de audio y encode/mux.
- Licencia verificada (npm + LICENSE del repo): Apache-2.0, compatible con repo MIT; sin archivo NOTICE upstream; se acredita en README.
- `@hyperframes/producer` añadido como peerDependency opcional (trae puppeteer + Chrome headless y requiere Node ≥22); import dinámico, tools reportan "unavailable" si falta.
- Actualizados AGENTS.md, fichas feat-captions y feat-render-export, READMEs.
- Node mínimo sube a 22 (requisito de HyperFrames y de vitest 5 vía @types/node); `npm ci` fallaba en main por ERESOLVE con @types/node 20 — corregido (@types/node ^22, CI node 22).
