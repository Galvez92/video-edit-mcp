# feat/render-export
**Status:** pending · **Order:** 3

## Goal
Final render with presets and a portable delivery package. **HyperFrames composes** the visual layers (captions, graphics/overlays, titles, transitions); **ffmpeg** does cut/concat of source clips, audio mix, and final encode/mux.

## Tools / API
- `compose { timeline, overlays?, captions?, output }` — builds a HyperFrames composition from the timeline and renders it (via `@hyperframes/producer`).
- `render { timeline|input, preset:"social-9x16"|"square"|"landscape-1080p"|"web-720p", output }` — ffmpeg encode presets (codec/bitrate/fps), muxing the HyperFrames layer when present.
- `export.package { video, subtitles?, spec?, output }` → ZIP with `video.mp4`, `captions.srt`, `spec.json` (probe + render settings + engine versions).

## Acceptance tests
- Each preset produces expected resolution/codec via probe.
- `compose` with one overlay on fixture → output duration matches timeline, overlay frame differs from source (pixel check). Skipped without HyperFrames/Chrome.
- ZIP contains the 3 entries and `spec.json` parses.
- HyperFrames absent → `compose` returns `isError` "unavailable", `render` without overlays still works.

## Dependencies
feat/core-ffmpeg; integrates captions, reframe, audio-mix. Optional peer `@hyperframes/producer` ^0.8.209 (Apache-2.0; puppeteer + headless Chrome; Node ≥22).
