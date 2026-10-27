# feat/captions
**Status:** pending · **Order:** 2 (parallel)

## Goal
Generate SRT and animated ASS captions from a transcript and burn them in.

## Tools / API
- `captions.generate { transcript, format:"srt"|"ass", style?, maxCharsPerLine?, maxLines? }` → file path.
- Styles (ASS): `plain`, `karaoke` (word highlight via `\k`), `pop` (scale-in), `box` (background).
- `captions.burn { input, subtitles, output, style? }` — ffmpeg `subtitles`/`ass` filter.

## Acceptance tests
- Transcript fixture → valid SRT (index, `HH:MM:SS,mmm`) and ASS with `[Events]`.
- Burn on fixture → output exists, same duration, re-encoded video stream.
- Line splitting respects limits.

## Dependencies
feat/core-ffmpeg; uses transcript shape from feat/transcribe (shape can be stubbed via fixture JSON).
