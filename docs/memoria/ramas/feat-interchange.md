# feat/interchange
**Status:** review · **Order:** 4

## Goal
Import edit decisions from other editors into a `Timeline`.

## Tools / API
- `import.edl { path, fps, mediaMap? }` → `Timeline` (CMX3600).
- `import.otio { path }` → `Timeline` (OpenTimelineIO JSON, clips/gaps on first video + audio tracks).
- Result can be passed to `cut.assemble` / `render`.

## Acceptance tests
- Hand-written EDL/OTIO fixtures → expected clip count, in/out in seconds.
- Malformed input → `isError` with line info.

## Dependencies
feat/core-ffmpeg (Timeline + assemble).

## Result
- `src/core/interchange.ts` — `parseEdl`/`importEdl` (CMX3600) and `importOtio` (OpenTimelineIO JSON), both returning `ImportedTimeline` (`Timeline` + non-fatal `warnings`). Output is validated with `validateTimeline`, so a broken import fails loudly instead of rendering wrong.
- `src/tools/interchange.ts` — registers `import.edl` and `import.otio`; the returned object goes straight into `render` (unknown keys such as `warnings` are ignored by the render schema). Frame geometry: 1920×1080 unless `width`/`height` are given (neither format carries a frame size).
- EDL: each event is a clip placed at its record position (`startSec`), so record gaps stay gaps; a dissolve (`D <frames>`) becomes a `crossfade` of `frames/fps`; `V`/`B` → video track, `A`/`A2`/`AA` → audio (channel digit picks the track), `AA/V` → both; `mediaMap` maps reel → path, unmapped reels are used as written and reported; a record duration that differs from the source duration is reported (speed changes are not imported); comments, `TITLE:` and `FCM:`/`AUD` headers are skipped; timecodes accepted as `HH:MM:SS:FF` or `HH:MM:SS;FF` (default 25 fps).
- OTIO: video/audio tracks in file order, each child advances the cursor (`Clip` → clip with `in` from `source_range.start_time`, `Gap` → empty space), `src` from `media_references.DEFAULT_MEDIA.target_url` (older `media_reference` also accepted, `file://` stripped), fps from the most common rational-time rate (24 assumed, with a warning, when the file has none).
- Not carried over (reported in `warnings`, never silently applied): effects, markers, time remaps, nested compositions, disabled items.
- Tests: `tests/interchange.test.ts` (5 — EDL happy path, malformed EDL with line number, missing file, OTIO clips + gaps, invalid JSON / empty stack); `tests/server.test.ts` tool list updated. `lint` and `typecheck` green; the full suite keeps only the 5 pre-existing HyperFrames/Chrome failures that `main` already has in this image.
