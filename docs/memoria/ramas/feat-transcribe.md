# feat/transcribe
**Status:** pending · **Order:** 2 (parallel)

## Goal
Local speech-to-text with Whisper (no cloud), word-level timestamps.

## Tools / API
- `transcribe { input, model?: "tiny"|"base"|"small"|..., language?, wordTimestamps? }` → `{ segments:[{start,end,text,words?}] , language }`.
- Backend: local Whisper CLI (e.g. whisper.cpp binary) detected via `health`; audio extracted with ffmpeg to 16 kHz mono WAV.
- Optional: write `.srt`/`.json` next to output.

## Acceptance tests
- Without backend → clear `isError` with install hint; `health` reports backend missing.
- With backend (opt-in env `VEM_WHISPER_TESTS=1`): short synthetic TTS or licensed speech clip returns non-empty segments with monotonic times.

## Dependencies
feat/core-ffmpeg.
