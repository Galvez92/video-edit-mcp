# feat/core-ffmpeg
**Status:** pending · **Order:** 1 (base for all feature branches)

## Goal
Basic non-destructive editing: cut, trim and concatenate clips; `cut.assemble` from a Timeline.

## Tools / API
- `trim { input, start, end, output, reencode? }` — stream copy when keyframe-safe, re-encode otherwise.
- `cut { input, segments:[{start,end}], output }` — keep listed segments, join.
- `concat { inputs[], output, normalize? }` — normalize resolution/fps/audio before joining.
- `cut.assemble { timeline, output }` — render a `Timeline` video track to a file.
- Core: progress parsing from ffmpeg `-progress`, output-path safety (no overwrite unless `overwrite:true`).

## Acceptance tests
- Trim 2s fixture to 0.5–1.5s → probe duration ≈1.0s (±0.1).
- Concat two fixtures of different sizes → single file, duration ≈ sum.
- Invalid ranges → `isError`.

## Dependencies
main.
