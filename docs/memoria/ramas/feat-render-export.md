# feat/render-export
**Status:** pending · **Order:** 3

## Goal
Final render with presets and a portable delivery package.

## Tools / API
- `render { timeline|input, preset:"social-9x16"|"square"|"landscape-1080p"|"web-720p", output }` (codec/bitrate/fps presets).
- `export.package { video, subtitles?, spec?, output }` → ZIP with `video.mp4`, `captions.srt`, `spec.json` (probe + render settings).
- Optional renderer adapter interface for HTML-composition renderers (pluggable, disabled by default, no hard dependency).

## Acceptance tests
- Each preset produces expected resolution/codec via probe.
- ZIP contains the 3 entries and `spec.json` parses.
- Adapter absent → tool reports unavailable, does not crash.

## Dependencies
feat/core-ffmpeg; integrates captions, reframe, audio-mix.
