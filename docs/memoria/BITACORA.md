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

## 2026-10-28 — feat/render-export — render desde Timeline + HyperFrames real
- `core/timelineRender.ts` (nuevo): `buildTimelineGraph()` → inputs `-ss/-t`, programa = primera pista de video (fit-and-pad + fps del preset, silencio si el clip no tiene audio, concat), pistas de audio concatenadas y mezcladas con `amix` (respeta `gainDb`), overlay alfa opcional (webm VP9 con libvpx-vp9).
- `render` acepta `input` o `timeline` (exactamente uno), y `overlay` (video alfa) o `hyperframes` (composición HTML → webm alfa con HyperFrames → overlay).
- `compose` ahora renderiza de verdad con `@hyperframes/producer` 0.8.210 (`createRenderJob`/`executeRenderJob`, formatos mp4/webm/mov), devDependency local + peer opcional; logs solo warn/error a stderr.
- Tests: `timeline-render.test.ts` y `hyperframes.test.ts` (se salta solo sin producer/Chrome). 43/43 verdes en Node 22 con Chrome; 41 + 2 skipped con `VEM_SKIP_HYPERFRAMES=1`. CI: job principal sin Chrome + job opcional `hyperframes`.
- vitest en serie (`fileParallelism: false`, timeouts 60 s) por timeouts bajo carga. Pendiente: transiciones y posición de clips/capa en el tiempo.

## 2026-10-28 · feat/render-export · transiciones, posición en el tiempo y capa con offset
- `Clip.startSec` y `Clip.transition {type, durationSec}`; `placeClips()` resuelve posiciones, rellena huecos (negro + silencio) y rechaza solapes sin transición.
- Transiciones `xfade` + `acrossfade` (crossfade, dissolve, fadeblack, fadewhite, wipe/slide izq/der), validadas contra la duración de los clips vecinos.
- Pistas de audio con `adelay` por clip + `amix`. `render.layerStartSec` / `layerDurationSec` para `overlay` y `hyperframes`.
- Tests: 53/53 verdes en Node 22 (incluye 3 HyperFrames reales con Chrome). Pendiente: varias capas HyperFrames por render.

## 2026-10-28 · feat/render-export · varias capas por render y crossfade en pistas de audio
- `render.layers[]` (`overlay` | `hyperframes`, `startSec`, `durationSec`, `zIndex`, `x`, `y`, `scale`) compuestas en orden de zIndex; `overlay`/`hyperframes`/`layerStartSec`/`layerDurationSec` siguen funcionando (se mapean a la primera capa).
- Pistas de audio: `transition crossfade|dissolve` solapa los clips automáticamente (fades tri emparejados + amix, equivalente a acrossfade; acrossfade literal se descartó porque deja el bed en silencio al mezclarlo junto a un programa de video). Otros tipos se rechazan en audio.
- Tests: 61/61 verdes en Node 22 con Chrome (incluye 4 HyperFrames reales).

## 2026-10-28 · feat/render-export · animación de capas y curvas de audio
- Capas: `fadeInSec`/`fadeOutSec` (fade alfa) y `enter`/`exit` (slide-left/right/up/down, scale) con `durationSec`; se valida que fades y movimientos quepan en la duración de la capa.
- Audio: `transition.curve` y `audioFade {inSec,outSec,curve}` con linear/exponential/log/s-curve/equal-power (tri/exp/log/hsin/qsin), misma curva en ambos lados del crossfade. Video sin cambios.
- Tests: 69/69 verdes en Node 22 (incluye HyperFrames reales). Pendiente de la rama: nada dentro de su alcance.

## 2026-10-28 · feat/render-export · fix: tamaño de capas con proporción
- Bug de la demo: `scale` era fracción del cuadro en ambos ejes y deformaba capas pequeñas (insignia 360x120 → ~356x634, fuera de cuadro).
- Ahora las capas conservan su proporción: `scale` = fracción del ancho del cuadro (`scaleMode: native` = fracción del tamaño propio), `width`/`height` en px, `fit: contain|cover|stretch`; sin tamaño se comportan igual que antes (cuadro completo). Posición fuera de cuadro se ajusta y se reporta en `warnings`. El resultado de `render` trae width/height/fps/codecs/bytes medidos.
- Tests: 79/79 verdes en Node 22 (incluye HyperFrames reales).

- 2026-10-28: con `width` + `height` el `fit` por defecto de las capas pasa de `stretch` a `contain` (aprobado por el owner); `stretch` sigue disponible de forma explícita.

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

## 2026-10-28 — feat/captions — tool MCP reframe (recorte, pad y seguimiento de sujeto)

> Implementada en la rama `feat/captions` (ficha `feat/reframe`), **sin fusionar a main** (queda en review).

- `reframe`: cambia el aspecto a `9:16`, `1:1`, `16:9` o `4:5`. Modos `crop` (recorte centrado, por defecto), `pad` (color sólido) y `blur-pad` (fondo borroso). En `crop`, `focusX`/`focusY` (0..1, defecto 0.5) sesgan el recorte y `follow: true` sigue al sujeto en el tiempo.
- Detección de rostro: integración opcional y de **carga lazy** (`REFRAME_FACE_MODULE` → módulo que exporta un `FaceDetector` `{detect(input,opts)=>Promise<{t,cx,cy}[]>}`). Sin detector configurado, `follow` responde `isError` "unavailable" y el recorte centrado sigue funcionando. Sin nuevas dependencias en runtime (offline).
- Lógica pura y testeada: `buildCropTrajectory` (selección de eje, clampeo, pares, expresión `crop` de ffmpeg piecewise-linear con escapes). Núcleo: `src/core/face-track.ts` (detector lazy + trayectoria), `src/core/reframe.ts` (aspectos, `cropWindow`/`cropOutput`/`focusOffset` + runner ffmpeg con `-c:a copy` y libx264/yuv420p), `src/tools/reframe.ts` (tool MCP). Registrada en `src/server.ts`.
- Tests: `tests/face-track.test.ts` (puros) y `tests/reframe.test.ts` (ffmpeg real con fixtures): 320x240→9:16 = 136x240 (pares, ratio ±1px), 1:1/16:9/4:5, escalado a 1080, `pad` y `blur-pad`, y caminos de error (falta input, sin video, salida existente, aspecto inválido, `follow` fuera de crop, `follow` unavailable). 52 tests en verde; lint, typecheck y build OK.
- Pendiente: el *runtime* de seguimiento (detector → frames → crop móvil) no se ejercita en sandbox/CI (sin detector); su camino unavailable sí está testeado, igual que el peer HyperFrames.
