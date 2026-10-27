# feat/interchange
**Status:** pending · **Order:** 4

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
