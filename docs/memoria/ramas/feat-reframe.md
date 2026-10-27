# feat/reframe
**Status:** pending · **Order:** 2 (parallel)

## Goal
Change aspect ratio to 9:16, 1:1 or 16:9.

## Tools / API
- `reframe { input, aspect:"9:16"|"1:1"|"16:9", mode:"crop"|"pad"|"blur-pad", focusX?: 0..1, output, height? }`.
- Crop centered or at `focusX`; pad with color or blurred background.

## Acceptance tests
- 320x240 fixture → 9:16 crop yields even dimensions with ratio 9:16 (±1px).
- `pad` keeps full frame; `blur-pad` output dimensions correct.

## Dependencies
feat/core-ffmpeg.
