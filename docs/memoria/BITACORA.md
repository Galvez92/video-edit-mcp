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

## 2026-10-28 — feat/transcribe (rama `local-whisper-transcription`) — transcripción local con Whisper
- Nuevo `src/core/whisper.ts`: backend Whisper **local y opcional** por CLI, sin dependencias npm nuevas ni addons nativos. whisper.cpp vía `-ojf` (tokens → palabras) y faster-whisper/whisper-ctranslate2 vía `--output_format json --word_timestamps`; detección lazy con caché en proceso y clasificación desde el `-h` del binario. Audio extraído con ffmpeg a 16 kHz mono en temporal que se borra siempre. Salida normalizada `{ language, backend, model?, segments:[{start,end,text,words?}] }`.
- Tool `transcribe { input, model?, language?, wordTimestamps? }` (errores → `isError` con pista de instalación); `health` ahora incluye `whisper`.
- Transporte HTTP: `GET /` devuelve una página índice (antes 404 `Not found`), usada también por el healthcheck del compose.
- Tests: `tests/transcribe.test.ts` (parseadores de ambos formatos, error sin backend, error sin archivo, pipeline completo con el doble `tests/stub-whisper-cli.mjs` y fixture generado con `testsrc`/`sine`). Test end-to-end con backend real detrás de `VEM_WHISPER_TESTS=1`: ejecutado y en verde en el sandbox con `whisper-ctranslate2` 0.5.8 + modelo `base` (instalados ad hoc, fuera de la imagen) y también por HTTP (`POST /mcp`) con audio real; sin backend instalado el test se salta con aviso y queda **por revisar**. `tests/server.test.ts` actualizado a las 3 tools.
- Entorno Base44: `docker-compose.base44.yml` + `docker/Dockerfile.base44` (node:22 + ffmpeg, código bind-mounted, `npm ci` + `tsx watch`, puerto 3000), `.base44/environment.json`, sección "Dev environment" en AGENTS.md.
- Verificación: `lint`, `typecheck`, `build` y `test` en verde (sin backend real: ese caso queda por revisar). Rama **no** fusionada a main.

## 2026-10-28 — feat/audio-mix (rama `local-whisper-transcription`) — mezcla de audio + loudnorm
- Nuevo `src/core/audiomix.ts` y 3 tools: `audio.measure` (loudnorm → LUFS/TP/LRA), `audio.loudnorm` (two-pass, target **-14 LUFS** por defecto / -1.5 dBTP) y `audio.mix` (voz + música con ducking por `sidechaincompress`, `amix` sin renormalizar, `afade`, video copiado y audio a AAC 192k, `-shortest`). `duck.threshold` en dB → amplitud lineal para ffmpeg; fuentes forzadas a mono.
- Tests `tests/audiomix.test.ts` (6: measure, loudnorm≈-14, mix 1 stream/duración=vídeo, y 3 error paths) con fixtures generados (testsrc/sine + clip sin audio). `tests/server.test.ts` actualizado a 6 tools.
- Verificación: `lint`/`typecheck`/`build` en verde; 19 tests OK + 1 saltado (transcribe real, por revisar). Audio tools verificados además por HTTP con audio real (loudnorm → -13.95 LUFS; mix 2.0 s / 1 stream). Rama **no** fusionada a main.
