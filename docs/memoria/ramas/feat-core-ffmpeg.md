# feat/core-ffmpeg
**Status:** in-progress · **Order:** 1 (base for all feature branches)

## Goal
Basic non-destructive editing: cut, trim and concatenate clips; `cut.assemble` from a Timeline.

## Tools / API
- `trim { input, start, end, output, reencode?, overwrite? }` — stream copy when keyframe-safe, re-encode otherwise (auto-detected; `reencode` forces either mode). **Done.**
- `cut { input, segments:[{start,end}], output, overwrite? }` — keep listed segments, join them in order. **Done.**
- `concat { inputs[], output, normalize?, overwrite? }` — normalize resolution/fps/audio before joining; `normalize:false` stream-copies compatible inputs. **Done.**
- `cut.assemble { timeline, output }` — render a `Timeline` video track to a file. **Pending** (not part of this delivery).
- Core: progress parsing from ffmpeg `-progress`, output-path safety (no overwrite unless `overwrite:true`). **Done.**

## Implementation notes
- `src/core/ffmpeg.ts`: `run()` now takes an optional stdout hook; `createProgressParser()` parses `-progress pipe:1` blocks (`out_time_us`/`out_time`/`out_time_ms`, tolerant to chunks that split lines); `ffmpegWithProgress()` spawns ffmpeg with `-nostats -progress pipe:1`. Progress uses stdout, so it is only used for runs that write to a file.
- `src/core/edit.ts` (new): `inspect()` (probe → duration/video/audio/size/fps), shared range validation, `outputArgs()` (refuses an existing output unless `overwrite:true`, then `-y`/`-n`), and the three primitives `trim`/`cut`/`concat`. `trim` probes keyframes with `ffprobe -show_entries packet=pts_time,flags` around the in-point (tolerance `0.5/fps`, min 20 ms); an unreadable probe falls back to re-encoding. `cut` and normalizing `concat` build one `-filter_complex` graph (`trim/atrim` + `concat`, or `scale`+`pad`+`fps`+`aformat` + `concat`) and always re-encode with libx264/aac. `concat` with `normalize:false` uses the concat demuxer with `-c copy` and a temp list file. Inputs that mix layouts (audio in some, not in others; video in some, not in others) are rejected with a clear message instead of producing a broken file.
- `src/core/timeline.ts`: added `validateTimeline()` (geometry, empty timeline/track, duplicate track ids, duplicate clip ids, per-clip errors) and `validateClip()` now requires `id` and `src`. `validateTimeline` is the entry point the pending `cut.assemble` will use.
- `src/server.ts`: registers `trim`, `cut`, `concat`; each handler returns JSON text, maps failures to `isError`, and forwards ffmpeg progress to the client only when the request carries a `progressToken`.

## Acceptance tests (vitest, fixtures from `scripts/make-fixtures.sh`)
- Trim 2s fixture to 0.5–1.5s → duration 0.9–1.1s, mode `reencode`; trim 0–1s → mode `copy`, duration 0.9–1.1s. ✅
- Concat two fixtures of different sizes → single file, duration ≈ sum (2.7–3.3s), video 640x360@30 and audio 48 kHz after normalization. ✅
- Invalid ranges (end ≤ start, start past the end, empty segments, mixed layouts) → `isError`. ✅
- Output safety: existing output is left untouched without `overwrite:true`, replaced with it. ✅
- `cut` on a video-only fixture → output has no audio stream. ✅
- Progress: parser unit tests plus a `trim` call reporting progress updates to the client. ✅

## Notes
- All work verified in a container with ffmpeg: `npm run lint`, `npm run typecheck`, `npm test` (24 tests, 0 skipped), `npm run build` all green; no media from third parties (synthetic `testsrc`/`sine` only).
- The tools were also exercised against the running HTTP server (`POST /mcp` on the sandbox port): `health` (both binaries available), `trim` 0.5–1.5s of the 2s fixture → duration 1.0s, `concat` of two different geometries → 3.03s, invalid range → `isError`.
- `npm ci` was already broken on `main`: the lockfile pinned `@types/node@20.19.43` while `vitest@5` needs `@types/node@^22 || >=24`, so npm aborted with `ERESOLVE`. This branch originally bumped `@types/node` to `^22.12.0`; that fix is now consolidated by the merged `docs/hyperframes-engine` branch (PR #1), which sets `engines.node` to `>=22` and `@types/node` to `^22.19.0`. `npm ci` installs again.
- `scripts/make-fixtures.sh` gained: `testsrc-wide.mp4` (640x360@30, 44.1 kHz audio), `testsrc-b.mp4` (same layout as the reference clip), `silent.mp4` (video only).
- Sandbox tooling (not application behaviour): `docker-compose.sandbox.yml` + `.sandbox/Dockerfile` run the HTTP transport from the cloned source with `tsx watch` on host port 3000.

## Dependencies
main.
