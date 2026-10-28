# feat/audio-mix
**Status:** review (en la rama `local-whisper-transcription`) · **Order:** 2 (parallel)

## Goal
Mix voice + music, ducking, loudness normalization.

## Implemented
- `src/core/audiomix.ts` + 3 tools (errores → `isError`, sin lanzar fuera del handler):
  - `audio.measure { input }` → `{ integratedLufs, truePeakDb, lra }` con `ffmpeg ... -af loudnorm=print_format=json -f null -`.
  - `audio.loudnorm { input, targetLufs?, truePeak?, output }` → **two-pass** `loudnorm`: pass 1 mide, pass 2 normaliza en modo `linear=true` con `measured_*` y `offset`. Target por defecto **-14 LUFS**, true peak -1.5 dBTP. Devuelve `{ output, measured, normalized }`.
  - `audio.mix { video, music, musicGainDb?, duck?, fadeIn?, fadeOut?, output }` → `filter_complex`: voz split como sidechain, `sidechaincompress` ducking sobre la música, `amix=inputs=2:duration=first:normalize=0` y `afade` opcional. Video copiado (`-c:v copy`), audio reencodeado a AAC 192k, `-shortest`. Devuelve `{ output, durationSec, audioStreams }`.
- Ducking: `duck.threshold` se pide en **dB** y se convierte a amplitud lineal para ffmpeg (que espera ~0.001–1). Defaults `{ threshold: -40, ratio: 10, attack: 5, release: 300 }` (ms).
- Ambas fuentes se fuerzan a mono (`aformat=channel_layouts=mono`) para que sidechain y amix tengan canales coincidentes.

## Notas
- Default loudness = **-14 LUFS** (fijado por la tarea; la ficha original decía -16). `targetLufs` es configurable.
- Sin dependencias npm nuevas; solo ffmpeg/ffprobe.

## Acceptance tests (`tests/audiomix.test.ts`, se saltan sin ffmpeg)
- `audio.measure` sobre un tono → loudness finito, LRA ≥ 0. ✅
- `audio.loudnorm -14` → loudness del salida dentro de -14 ±1.5 LUFS (medido -13.95). ✅
- `audio.mix` (vídeo + música, fades) → 1 pista de audio, duración = vídeo (2.0 ±0.3). ✅
- `audio.measure` / `audio.mix` con archivos inexistentes → `isError`. ✅
- `audio.mix` con vídeo sin pista de audio → `isError` "no audio track". ✅
- Verificado además por HTTP (`POST /mcp`) con fixtures reales.

## Dependencies
feat/core-ffmpeg.
