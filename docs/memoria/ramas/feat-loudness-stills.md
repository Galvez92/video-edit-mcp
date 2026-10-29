# feat/loudness-stills
**Status:** draft PR · **Order:** after feat/render-captions

## Goal
Delivery-ready audio level and still images as first-class timeline clips.

## API
- `render { …, loudness?: { targetLufs?, truePeakDb?, lra? } }` → `loudness: { target, before, after, mode }` + `<output>.loudness.json`; `program: { durationSec, clipsSec, overlapSec, gapSec }`.
- `export.package { …, loudness? }` → `spec.loudnessNormalization`.
- Clip `{ src: "x.png|jpg|webp", durationSec, still?: { fit?: "contain"|"cover", kenBurns?: { zoomFrom?, zoomTo?, from?: {x,y}, to?: {x,y} } } }`.

## Decisions
- Loudness off by default (it changes the mix); defaults -16 LUFS / -1 dBTP / LRA 11 when enabled. Applied last so captions/layers do not alter it.
- Two-pass linear loudnorm; if the peak ceiling forces compression, `mode: "dynamic"` is reported instead of hidden.
- Stills: `-loop 1 -framerate fps -t d`; Ken Burns with `zoompan` (d=1) on a 2x upscale to limit jitter.

## Tests
`tests/loudness-stills.test.ts`.
