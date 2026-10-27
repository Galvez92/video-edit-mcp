# feat/audio-mix
**Status:** pending · **Order:** 2 (parallel)

## Goal
Mix voice + music, ducking, loudness normalization.

## Tools / API
- `audio.mix { video, music, musicGainDb?, duck?:{threshold,ratio,attack,release}, fadeIn?, fadeOut?, output }` — `sidechaincompress` ducking.
- `audio.loudnorm { input, targetLufs = -16, truePeak = -1.5, output }` — two-pass `loudnorm`.
- `audio.measure { input }` → integrated LUFS, true peak, LRA.

## Acceptance tests
- Loudnorm fixture → measured integrated loudness within -16 ±1 LUFS.
- Mix → output has one audio stream, duration = video duration.

## Dependencies
feat/core-ffmpeg.
