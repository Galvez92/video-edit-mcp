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

## 2026-10-28 — feat/captions — subtítulos SRT/ASS y captions animados + burn-in

> Rama abierta, **sin fusionar a main** (queda en review).

- `captions.generate`: segmentos de transcripción (inline o JSON) o un SRT → SRT, ASS o composición HyperFrames (HTML). Estilos `plain`, `karaoke` (resaltado por palabra), `pop` (escala de entrada) y `box` (placa de fondo); límites `maxCharsPerLine`/`maxLines` respetados.
- `captions.render`: burn-in sobre el video conservando el audio de origen. Motor por defecto HyperFrames (capa alfa ProRes 4444 + overlay ffmpeg); motor `ffmpeg` con ASS/libass como respaldo, sin dependencia extra.
- Núcleo: `src/core/subtitles.ts` (modelo de cues + palabras, SRT, ASS v4.00+, karaoke `\k`, pop `\t`, box `BorderStyle 3`), `src/core/captions.ts` (chunking y composición HyperFrames con un elemento temporizado por chunk, animaciones CSS word-pop/karaoke relativas al `data-start` del elemento), `src/core/hyperframes.ts` (import dinámico del peer opcional `@hyperframes/producer`; ausente → `isError` "unavailable"), `src/core/caption-render.ts` (selección de motor, guarda de sobrescritura, mux/encode con `-c:a copy`).
- Fixture `tests/fixtures/sample.srt` (texto sintético) como entrada mientras `feat/transcribe` no está en la rama.
- Tests: `subtitles`, `captions` (chunking + composición), `captions-tool` (MCP, caminos de error) y `captions-render` (ffmpeg real, se salta sin ffmpeg); `server.test.ts` actualizado a las cuatro tools. Total 38 tests en verde, más lint, typecheck y build.
- Verificación end-to-end por el transporte HTTP: SRT → SRT idéntico, ASS con `[Events]`, composición con 3 chunks temporizados; render con motor `ffmpeg` sobre clip sintético → h264 + aac, duración 2.00 s, y el texto realmente dibujado (clip negro: `YMAX` 16 → 238).
- Entorno del sandbox (`docker-compose.base44.yml`, `Dockerfile.base44`, `.base44/environment.json`): ffmpeg + `tsx watch` desde el código montado, transporte HTTP en el puerto 3000.
- Pendiente: el camino de render HyperFrames no se pudo ejecutar en el sandbox (peer opcional con Chrome no instalado); su test se salta.
