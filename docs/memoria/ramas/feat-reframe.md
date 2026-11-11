# feat/reframe
**Status:** review (implemented on `feat/captions`) · **Order:** 2 (parallel)

## Goal
Change aspect ratio to 9:16, 1:1, 16:9 or 4:5 with a centered crop, padding, or subject-following crop.

## Tools / API
- `reframe { input, output, aspect:"9:16"|"1:1"|"16:9"|"4:5", mode?:"crop"|"pad"|"blur-pad", focusX?: 0..1, focusY?: 0..1, follow?: boolean, height?, padColor?, overwrite? }`.
- `crop` (default): centered largest crop matching the target aspect, even dimensions; `focusX`/`focusY` (0..1, default 0.5) bias the crop along the cropped axis.
- `follow: true` (crop only): track the subject over time with a lazily-loaded face detector and slide the crop window along the cropped axis. The detector is a pluggable, optional integration (env `REFRAME_FACE_MODULE` → a module exporting `{ detect(input, opts?) => Promise<{t,cx,cy}[]> }`); when none is configured the tool returns `isError` "unavailable", and the centered-crop path is unaffected. Pure trajectory math (`buildCropTrajectory`) turns detections into clamped, even, piecewise-linear ffmpeg `crop` expressions.
- `pad`: scale the full frame down into the target canvas (no crop), pad the margins with `padColor` (default `black`).
- `blur-pad`: blurred, cover-scaled background behind the centered full frame.
- `height` scales the output (crop) or sets the canvas (pad/blur-pad); defaults keep the crop/source height. Audio is copied (`-c:a copy`); video re-encoded to libx264/yuv420p.

## Implementation
- `src/core/face-track.ts`: `FaceDetection`/`FaceDetector` types, lazy `loadFaceDetector()` (null when unset/unresolvable), `buildCropTrajectory()` (axis selection, clamping, even rounding, ffmpeg expression builder with comma escaping).
- `src/core/reframe.ts`: aspect table, `cropWindow`/`croppedAxis`/`cropOutput`/`focusOffset` helpers and the `reframe()` runner (probe → filter → ffmpeg; overwrite guard; subject-follow wiring).
- `src/tools/reframe.ts`: MCP tool registration (zod schema, JSON output, `isError` on failure).
- Registered in `src/server.ts`; tool list updated in `tests/server.test.ts`.

## Acceptance tests
- `tests/face-track.test.ts` (pure): `clampEven`, trajectory centering/clamping/evenness, y-axis sliding, null-axis fallback, centered fallback with no detections, `loadFaceDetector` null paths.
- `tests/reframe.test.ts` (ffmpeg, fixtures): 320x240 → 9:16 crop = 136x240 (even, ratio within ±1px); 1:1/16:9/4:5 crop windows; crop scaled to height 1080; `pad` and `blur-pad` to 9:16; errors for missing input / no video / existing output / bad aspect; `follow` rejected outside crop and reported unavailable with no detector.
- 52 tests total green; lint, typecheck, build green.

## Dependencies
feat/core-ffmpeg. No new runtime deps (face detector is a pluggable, lazily-loaded, operator-supplied module).

## Notes / open
- The follow *runtime* (detector → frames → ffmpeg moving crop) is not exercised in the sandbox/CI: no detector is configured, so its test asserts the unavailable path, mirroring the HyperFrames peer pattern. The trajectory math that follow relies on is covered by pure unit tests.
- To enable follow, install/import a lightweight offline face detector and point `REFRAME_FACE_MODULE` at it.
