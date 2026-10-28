# feat/captions
**Status:** pending · **Order:** 2 (parallel)

## Goal
Animated captions from a transcript. **HyperFrames is the primary renderer** (HTML/CSS/GSAP caption composition → frames); ffmpeg composites/muxes onto the source and encodes. SRT/ASS remain as export formats and ffmpeg-only fallback.

## Tools / API
- `captions.generate { transcript, format:"srt"|"ass"|"hyperframes", style?, maxCharsPerLine?, maxLines? }` → file path (SRT, ASS, or HyperFrames composition HTML).
- Styles: `plain`, `karaoke` (word highlight), `pop` (scale-in), `box` (background); implemented as HyperFrames templates, ASS approximation for fallback.
- `captions.render { input, transcript|composition, output, style?, engine?:"hyperframes"|"ffmpeg" }` — default `hyperframes`; renders caption layer (alpha) and ffmpeg overlays + encodes keeping source audio.

## Acceptance tests
- Transcript fixture → valid SRT (`HH:MM:SS,mmm`), ASS with `[Events]`, and HyperFrames composition HTML with one timed element per caption chunk.
- HyperFrames render on fixture → output exists, same duration (±1 frame), audio stream preserved. Skipped if `@hyperframes/producer` or Chrome missing.
- Engine absent → `engine:"hyperframes"` returns `isError` "unavailable"; `engine:"ffmpeg"` still works.
- Line splitting respects limits.

## Dependencies
feat/core-ffmpeg; transcript shape from feat/transcribe (stub via fixture JSON). Optional peer `@hyperframes/producer` ^0.8.209 (Apache-2.0, Node ≥22, headless Chrome).
