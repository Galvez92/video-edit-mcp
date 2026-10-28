# feat/captions
**Status:** review · **Order:** 2 (parallel)

## Goal
Animated captions from a transcript. **HyperFrames is the primary renderer** (HTML/CSS/GSAP caption composition → frames); ffmpeg composites/muxes onto the source and encodes. SRT/ASS remain as export formats and ffmpeg-only fallback.

## Tools / API
- `captions.generate { transcript|srt, format:"srt"|"ass"|"hyperframes", output, style?, maxCharsPerLine?, maxLines?, width?, height?, duration? }` → written file + summary (cues, bytes, duration).
- `captions.render { input, transcript|srt|composition, output, style?, engine?:"hyperframes"|"ffmpeg", width?, height?, fps?, overwrite? }` → rendered video, source audio kept.
- Styles: `plain`, `karaoke` (word highlight), `pop` (scale-in), `box` (background); HyperFrames templates with an ASS approximation for the fallback.
- Input is either transcription segments (inline, or a JSON file with `{segments:[…]}`) or an SRT file.

## Implemented (2026-10-28, branch)
- `src/core/subtitles.ts` — caption model (cues + word timings), SRT parse/format (`HH:MM:SS,mmm`), ASS writer (`[Script Info]`/`[V4+ Styles]`/`[Events]`, karaoke `\k`, pop `\t` scale-in, box `BorderStyle 3`), stamp parser for both dialects.
- `src/core/captions.ts` — transcript segments → chunks (greedy wrap by `maxCharsPerLine`, packed by `maxLines`, word timings kept when the transcriber provides them, otherwise split proportionally), and the HyperFrames composition HTML: root `data-composition-id`/`data-width`/`data-height`/`data-duration`, one timed element (`data-start`/`data-duration`/`data-track-index`) per chunk, word-pop and karaoke CSS animations (delays relative to the element start, which is how the producer runtime seeks).
- `src/core/hyperframes.ts` — lazy dynamic import of the optional peer `@hyperframes/producer`; `renderLayer` renders the composition to an alpha layer (ProRes 4444 `mov`) and returns `null`→"unavailable" when the peer is missing.
- `src/core/caption-render.ts` — engine selection, temp workspace, overwrite guard, ffmpeg burn-in (libass `ass=` filter) or overlay of the HyperFrames layer with `-c:a copy` to keep the source audio.
- `src/tools/captions.ts` — the two MCP tools; error paths return `isError` instead of throwing.
- Fixture `tests/fixtures/sample.srt` (synthetic text) stands in while `feat/transcribe` is not on this branch. No shared config changed.
- Tests: `tests/subtitles.test.ts`, `tests/captions.test.ts`, `tests/captions-tool.test.ts`, `tests/captions-render.test.ts` (skips without ffmpeg); `tests/server.test.ts` updated to the four registered tools.

## Verified (2026-10-28)
- lint + typecheck + build green; 38 tests pass (`npm test` inside the sandbox container).
- Over the HTTP transport: SRT fixture → SRT identical round-trip, ASS with `[Events]`, composition with 3 timed chunks; `captions.render engine:"ffmpeg"` on a generated clip → h264 + aac kept, duration 2.00 s, and libass really draws text (black clip: `YMAX` 16 → 238 after burn-in).
- `engine:"hyperframes"` without the peer → `isError` "unavailable".

## Notes / pending
- The HyperFrames render path itself is **not exercised** here: the optional peer (puppeteer + headless Chrome) is not installed in the sandbox and CI does not install it either — the render test skips, as agreed for this engine.
- `captions.render` defaults to `engine:"hyperframes"`; users without the peer must pass `engine:"ffmpeg"`.

## Acceptance tests
- Transcript fixture → valid SRT (`HH:MM:SS,mmm`), ASS with `[Events]`, and HyperFrames composition HTML with one timed element per caption chunk. ✅
- HyperFrames render on fixture → output exists, same duration (±1 frame), audio stream preserved. Skipped if `@hyperframes/producer` or Chrome missing. ⏳ skipped (peer absent)
- Engine absent → `engine:"hyperframes"` returns `isError` "unavailable"; `engine:"ffmpeg"` still works. ✅
- Line splitting respects limits. ✅

## Dependencies
feat/core-ffmpeg; transcript shape from feat/transcribe (stub via fixture JSON). Optional peer `@hyperframes/producer` ^0.8.209 (Apache-2.0, Node ≥22, headless Chrome).
