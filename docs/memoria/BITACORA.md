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

## 2026-10-27 — feat/core-ffmpeg — wrapper ffmpeg/ffprobe + tools cut, trim y concat
- `core/ffmpeg.ts`: hook de stdout en `run()`, parser incremental de `-progress pipe:1` (bloques key=value, tolerante a cortes entre chunks) y `ffmpegWithProgress()`.
- `core/edit.ts` (nuevo): `inspect()`, validación de rangos, seguridad de ruta de salida (no sobrescribe sin `overwrite:true`) y las primitivas `trim` (stream copy si el inicio cae en keyframe, si no re-encode), `cut` (trim/atrim + concat en un solo `-filter_complex`) y `concat` (normaliza scale/pad/fps/aformat, o copia de flujo con el demuxer concat si `normalize:false`).
- `core/timeline.ts`: `validateTimeline()` y validación de `id`/`src` por clip.
- Tools MCP registradas: `trim`, `cut`, `concat` (schema zod + salida JSON, errores como `isError`); progreso reenviado al cliente solo si la petición trae `progressToken`.
- Fixtures sintéticos ampliados en `scripts/make-fixtures.sh` (clip 640x360@30 con audio 44.1 kHz, clip compatible para copia de flujo, clip sin audio).
- Tests vitest nuevos: `edit.test.ts` (happy + errores, duración ≈ suma, sin audio, protección de sobrescritura, progreso), `ffmpeg.test.ts` (parser), `timeline.test.ts` (validateTimeline). Verdes junto a lint, typecheck y build.
- Verificado además contra el servidor HTTP en marcha: `health`, `trim` 0.5–1.5 s → 1.0 s, `concat` de dos geometrías → 3.03 s y rango inválido → `isError`.
- Pendiente en la rama: `cut.assemble` desde un `Timeline`. Sin releases ni fusión a `main`.

## 2026-10-27 — feat/render-export — presets de encode, export.package y compose opcional
- `core/render.ts`: presets `web-1080p`, `vertical-9x16`, `square` (H.264+AAC, fit-and-pad, 30 fps) y `audio-only` (AAC .m4a); `measureLoudness()` con pasada de análisis `loudnorm` (sin valores fijos); `exportPackage()` → ZIP con media, `captions.srt` opcional, `spec.json` medido con ffprobe y `checksums.sha256`.
- `core/zip.ts`: escritor ZIP sin dependencias (`node:zlib` deflate + crc32).
- `core/compose.ts`: import perezoso de `@hyperframes/producer`; si falta, "unavailable".
- Tools MCP: `render`, `export.package`, `compose`. Tests en `tests/render.test.ts` con fixtures generados por ffmpeg. Base: origin/main 60d4d2f. PR en draft, sin fusión.
