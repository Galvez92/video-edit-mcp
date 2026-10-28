# Bitácora (log único)

Formato: `## YYYY-MM-DD — rama — resumen` + detalles (qué, tests, pendientes). Solo se agrega al final.

## 2026-10-27 — main — esqueleto inicial
- Servidor MCP TypeScript (ESM, Node 20+) con transportes stdio y Streamable HTTP (`--http --port`).
- Tools implementadas: `health` (disponibilidad de ffmpeg/ffprobe) y `probe` (ffprobe normalizado).
- `core/ffmpeg.ts`, `core/timeline.ts` (tipos Timeline/Track/Clip).
- Tests vitest: listado de tools, health, probe sobre fixture generado (testsrc + sine), timeline. Se saltan si no hay ffmpeg.
- CI GitHub Actions (ffmpeg + npm ci + lint + typecheck + test + build).
- Fichas creadas en `docs/memoria/ramas/` para las 9 ramas planeadas (todas `pending`).

## 2026-10-27 — feat/core-ffmpeg — wrapper ffmpeg/ffprobe + tools cut, trim y concat
- `core/ffmpeg.ts`: hook de stdout en `run()`, parser incremental de `-progress pipe:1` (bloques key=value, tolerante a cortes entre chunks) y `ffmpegWithProgress()`.
- `core/edit.ts` (nuevo): `inspect()`, validación de rangos, seguridad de ruta de salida (no sobrescribe sin `overwrite:true`) y las primitivas `trim` (stream copy si el inicio cae en keyframe, si no re-encode), `cut` (trim/atrim + concat en un solo `-filter_complex`) y `concat` (normaliza scale/pad/fps/aformat, o copia de flujo con el demuxer concat si `normalize:false`).
- `core/timeline.ts`: `validateTimeline()` y validación de `id`/`src` por clip.
- Tools MCP registradas: `trim`, `cut`, `concat` (schema zod + salida JSON, errores como `isError`); progreso reenviado al cliente solo si la petición trae `progressToken`.
- Fixtures sintéticos ampliados en `scripts/make-fixtures.sh` (clip 640x360@30 con audio 44.1 kHz, clip compatible para copia de flujo, clip sin audio).
- Tests vitest nuevos: `edit.test.ts` (happy + errores, duración ≈ suma, sin audio, protección de sobrescritura, progreso), `ffmpeg.test.ts` (parser), `timeline.test.ts` (validateTimeline). Verdes junto a lint, typecheck y build.
- Arreglo de instalación: `@types/node` sube de `^20.19.43` a `^22.12.0` (solo tipos, `engines` sin cambios) porque `vitest@5` exige `^22 || >=24` y `npm ci` fallaba con `ERESOLVE` también en `main`; hay que llevarlo a `main` para que su CI pase.
- Verificado además contra el servidor HTTP en marcha: `health`, `trim` 0.5–1.5 s → 1.0 s, `concat` de dos geometrías → 3.03 s y rango inválido → `isError`.
- Pendiente en la rama: `cut.assemble` desde un `Timeline`. Sin releases ni fusión a `main`.
