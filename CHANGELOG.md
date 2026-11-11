# Changelog

## 0.1.0 — 2026-10-29

First public release. Local MCP server for video editing over stdio or Streamable HTTP.

### Added
- Core ffmpeg tools: `health`, `probe`, `trim`, `cut`, `concat`.
- `render`: presets `web-1080p`, `vertical-9x16`, `square`, `audio-only`; multi-track timelines with transitions, still images (contain/cover, Ken Burns), overlay and HyperFrames HTML layers (aspect-preserving sizing, `fit` contain/cover/stretch), captions burned in after composition, optional two-pass loudness normalization (linear or limited mode). Returns measured specs and effective program duration.
- `export.package`: delivery ZIP with media, `captions.srt`, `spec.json` (EBU R128 loudness) and `checksums.sha256`.
- `compose`: render HyperFrames compositions (optional peer `@hyperframes/producer`).
- `transcribe`: local Whisper (whisper.cpp / faster-whisper) with word timestamps.
- `captions.generate` (SRT, ASS, animated HyperFrames: plain, karaoke, pop, box) and `captions.render` (HyperFrames or ffmpeg/libass fallback).
- `reframe`: 9:16, 1:1, 16:9, 4:5 via crop (focus / follow), color pad or blurred pad.
- Audio: `audio.measure`, `audio.loudnorm`, `audio.mix` (sidechain ducking, fades).
- CI (tests + HyperFrames job), CodeQL, Dependabot, SECURITY.md, English and Spanish READMEs.
