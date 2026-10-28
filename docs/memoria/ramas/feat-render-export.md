# feat/render-export
**Status:** in review (draft PR) · **Order:** 3

## Goal
Final render with presets and a portable delivery package. **HyperFrames composes** the visual layers (captions, graphics/overlays, titles, transitions); **ffmpeg** does cut/concat of source clips, audio mix, and final encode/mux.

## Tools / API (implemented)
- `render { input, preset, output, overwrite? }` — ffmpeg encode presets (`src/core/render.ts`):
  - `web-1080p` 1920x1080 · `vertical-9x16` 1080x1920 · `square` 1080x1080 — H.264 yuv420p + AAC 48 kHz stereo, 30 fps, fit-and-pad, `+faststart`.
  - `audio-only` — AAC 192k 48 kHz `.m4a`.
- `export.package { video, output, subtitles?, preset?, overwrite? }` → ZIP with `video.mp4` (or `audio.m4a`), optional `captions.srt`, `spec.json` and `checksums.sha256`.
  - `spec.json` values are **measured** on the delivered file: duration/container/size/codecs/resolution/fps via ffprobe; loudness (integrated LUFS, true peak, LRA, threshold) via a `loudnorm=print_format=json` analysis pass; omitted when there is no audio. Includes the ffmpeg version and sha256 per entry.
  - ZIP is written by a dependency-free writer (`src/core/zip.ts`, deflate via `node:zlib`).
- `compose { composition, output, width?, height?, fps? }` — lazy `import("@hyperframes/producer")` (optional peer). Missing → `isError` "unavailable". The ffmpeg tools never load it.

## Acceptance tests (`tests/render.test.ts`)
- Each video preset → expected resolution/codec/fps via probe; audio-only → no video stream.
- ZIP contains the 4 entries, `spec.json` parses, checksums match; loudness differs by >15 LU between a fixture and a −20 dB copy (proves it is measured).
- No audio → no loudness block. HyperFrames absent → `compose` returns "unavailable".
- Pending: `compose` pixel/duration test with HyperFrames + Chrome installed (skipped in CI); `render` from a `timeline` and muxing a HyperFrames layer.

## Dependencies
feat/core-ffmpeg; integrates captions, reframe, audio-mix. Optional peer `@hyperframes/producer` ^0.8.209 (Apache-2.0; puppeteer + headless Chrome; Node ≥22).
