# feat/transcribe
**Status:** review (en la rama `local-whisper-transcription`) · **Order:** 2 (parallel)

## Goal
Local speech-to-text with Whisper (no cloud), word-level timestamps.

## Implemented
- `transcribe { input, model?, language?, wordTimestamps? }` → `{ language, backend, model?, segments:[{start,end,text,words?}] }`.
- `src/core/whisper.ts`: **backend local opcional por CLI**, sin dependencias npm nuevas ni addons nativos (regla del repo). Nada se prueba ni se carga al importar: la detección es lazy, con caché en proceso por entorno.
  - whisper.cpp (`whisper-cli`, `whisper-cpp`, `whisper`): se invoca con `-ojf` (JSON con tokens) y los sub-tokens se fusionan en palabras (un token que empieza con espacio abre palabra; los tokens especiales `[_BEG_]`, `[BLANK_AUDIO]`, … se descartan).
  - faster-whisper / whisper-ctranslate2: `--output_format json --word_timestamps True|False`.
  - El tipo de backend se clasifica con el texto de `-h` del binario (o se forza con `VEM_WHISPER_BACKEND`).
- Audio extraído con ffmpeg a 16 kHz mono PCM en un directorio temporal que se borra siempre (incluso si el backend falla).
- `health` añade `whisper: { available, kind?, command?, model?, error?, hint? }`.
- Fallos → `isError` con pista de instalación o de modelo; nunca se lanza fuera del handler.

## Variables de entorno
| Var | Uso |
|---|---|
| `VEM_WHISPER_CMD` | binario explícito del backend (sustituye la búsqueda en PATH) |
| `VEM_WHISPER_BACKEND` | fuerza `whisper.cpp` o `faster-whisper` |
| `VEM_WHISPER_MODEL` | archivo de modelo de whisper.cpp (p. ej. `ggml-base.bin`) |
| `VEM_WHISPER_MODEL_DIR` | carpeta con `ggml-<model>.bin` (por defecto `models/` y `.`) |
| `VEM_WHISPER_TIMEOUT_MS` | timeout del backend (por defecto 600000) |
| `VEM_WHISPER_TESTS=1` | activa el test end-to-end con backend real |

Timeout del proceso del backend y del `-h` de detección: constantes en `src/core/whisper.ts`.

## Acceptance tests
- Sin backend → `isError` con pista de instalación; `health` reporta backend missing. **Cubierto** (`tests/transcribe.test.ts`, forzando `VEM_WHISPER_CMD` a un binario inexistente).
- Sin archivo de entrada → `isError`. **Cubierto**.
- Con backend y fixture generado: pipeline completo (extracción ffmpeg → spawn → JSON → normalización) contra el doble de test `tests/stub-whisper-cli.mjs`, que responde a `-h` como whisper.cpp y escribe un JSON canónico: 2 segmentos, tiempos monótonos, palabras fusionadas con timestamps dentro de su segmento, `wordTimestamps:false` sin palabras. **Cubierto** (se salta sin ffmpeg).
- Parseadores de ambos formatos con JSON sintético propio. **Cubierto**.
- Backend real (audio TTS sintético con `espeak-ng`/`espeak`, `VEM_WHISPER_TESTS=1`): **ejecutado y en verde** con `whisper-ctranslate2` 0.5.8 + modelo `base` → segmentos no vacíos, tiempos monótonos y palabras con timestamps; mismo caso verificado además por el transporte HTTP (`POST /mcp`) con audio real. Ese backend se instaló *ad hoc* en el contenedor de desarrollo (no forma parte de la imagen), así que en un entorno o CI sin backend/modelo el test se salta con aviso y el caso queda **por revisar**.

## Notas / pendientes
- Salida opcional `.srt`/`.json` **no** implementada aquí: SRT/ASS son de `feat/captions` (evita duplicar formato entre ramas).
- La documentación de usuario en README queda para `docs/readme` (esa rama es dueña del README).
- `transcribe` no descarga nada: modelo y binario son locales, el tool solo lee archivos locales.

## Dependencies
feat/core-ffmpeg.
