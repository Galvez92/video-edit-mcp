# feat/render-export
**Status:** in review (draft PR #3) · **Order:** 3

## Goal
Final render with presets and a portable delivery package. **HyperFrames composes** the visual layers (captions, graphics/overlays, titles, transitions); **ffmpeg** does cut/concat of source clips, audio mix, and final encode/mux.

## Tools / API (implemented)
- `render { input | timeline, preset, output, overlay?, hyperframes?, overwrite? }` — ffmpeg encode presets (`src/core/render.ts`). With a `timeline` (`src/core/timelineRender.ts`): the first `video` track is the program (each clip trimmed with input `-ss/-t`, fit-and-padded to the preset frame, concatenated with its own audio or generated silence); `audio` tracks are concatenated and mixed under it with `amix` (clip `gainDb` applies); `caption` tracks are ignored. `overlay` = alpha video (webm VP9 decoded with libvpx-vp9 / mov ProRes 4444) scaled to the frame and composited on top; `hyperframes` = composition HTML rendered to an alpha webm with HyperFrames first, then overlaid.
  - `web-1080p` 1920x1080 · `vertical-9x16` 1080x1920 · `square` 1080x1080 — H.264 yuv420p + AAC 48 kHz stereo, 30 fps, fit-and-pad, `+faststart`.
  - `audio-only` — AAC 192k 48 kHz `.m4a`.
- `export.package { video, output, subtitles?, preset?, overwrite? }` → ZIP with `video.mp4` (or `audio.m4a`), optional `captions.srt`, `spec.json` and `checksums.sha256`.
  - `spec.json` values are **measured** on the delivered file: duration/container/size/codecs/resolution/fps via ffprobe; loudness (integrated LUFS, true peak, LRA, threshold) via a `loudnorm=print_format=json` analysis pass; omitted when there is no audio. Includes the ffmpeg version and sha256 per entry.
  - ZIP is written by a dependency-free writer (`src/core/zip.ts`, deflate via `node:zlib`).
- `compose { composition, output, fps?, format?, quality? }` — real HyperFrames render via `createRenderJob`/`executeRenderJob` of `@hyperframes/producer` (optional peer; installed as devDependency for tests). `composition` = HTML file (its folder is the project) or a folder with `index.html`; canvas size comes from the composition. `format` mp4 (opaque) | webm (VP9 alpha) | mov (ProRes 4444 alpha). Producer logs: warn/error only, to stderr. Missing peer → `isError` "unavailable"; render failures → "hyperframes render failed: <producer message>".

## Acceptance tests (`tests/render.test.ts`)
- Each video preset → expected resolution/codec/fps via probe; audio-only → no video stream.
- ZIP contains the 4 entries, `spec.json` parses, checksums match; loudness differs by >15 LU between a fixture and a −20 dB copy (proves it is measured).
- No audio → no loudness block. HyperFrames absent → `compose` returns "unavailable".
- `tests/timeline-render.test.ts`: graph unit tests (trim args, silence fill, concat, music mix, alpha overlay input, audio-only, invalid timeline) + real renders: 3 clips (in/out, 640x360@30 + 320x240@25 + no-audio clip) with a −12 dB music bed → 1080x1920 h264/aac 48k, ≈2.5 s; audio-only timeline → ≈1.25 s; input+timeline and missing sources → errors.
- `tests/hyperframes.test.ts` (real HyperFrames + Chrome; skipped automatically when the producer or a launchable Chrome is missing, or `VEM_SKIP_HYPERFRAMES=1`): composition with the fixture clip as `<video>` + red title band → 320x240 h264, 2.0 s, title pixel red, same pixel not red in the source; `render` of a timeline with a `hyperframes` layer → 1920x1080, 2.0 s, title band red at frame centre and program visible where the layer is transparent.
- Composition notes: mark the root with `data-no-timeline` when it has no GSAP timeline (otherwise the producer waits 45 s for `window.__timelines`).
- CI: main job sets `PUPPETEER_SKIP_DOWNLOAD=true` (HyperFrames tests skip); optional `hyperframes` job (`continue-on-error`) downloads Chrome through puppeteer and runs only `tests/hyperframes.test.ts`.
- vitest runs files sequentially (`fileParallelism: false`, 60 s timeouts): ffmpeg + Chrome renders time out when they compete on a busy machine.
- Timeline placement (`placeClips` in `src/core/timeline.ts`): clip `startSec` places it absolutely; otherwise it follows the previous clip. Gaps on the program → `color=black` + `anullsrc` segments. Overlaps on a video/audio track without a transition → validation error ("overlaps clip X … join them with a transition").
- Transitions: clip `transition {type, durationSec}` joins it to the previous clip (overlap = durationSec). Types `crossfade|dissolve|fadeblack|fadewhite|wipeleft|wiperight|slideleft|slideright` → ffmpeg `xfade` (video) + `acrossfade` (program audio); audio-track clips get `afade` in/out. Validated: not on the first clip, 0 < d ≤ both neighbouring clip lengths, startSec (if set) must equal the joined position.
- Audio tracks: each clip trimmed, `adelay` to its start, mixed with `amix` (gaps = silence).
- Layer timing: `render.layerStartSec` (setpts offset) and `layerDurationSec` (`overlay enable='between(t,…)'`) for `overlay` and `hyperframes`.
- Tests: graph units (xfade offsets, gap colour sources, overlap/too-long/first-clip errors, adelay + layer offset) + real renders: 5 clips with crossfade/fadeblack/wipeleft/slideright → 4.1 s (sum − overlaps); startSec gap → black + silent at 1.5 s, pattern at 0.5/2.5 s; audio clip startSec 1 → silence before; overlap rejected; alpha red layer at 1–1.5 s pixel-checked at 0.5/1.2/1.8 s; HyperFrames layer with layerStartSec 1 (self-skips without Chrome).
- Pending: transitions on the audio track are fades over an overlap the user sets by startSec (no auto overlap); per-clip HyperFrames layers (one layer per render for now).

## Dependencies
feat/core-ffmpeg; integrates captions, reframe, audio-mix. Optional peer `@hyperframes/producer` ^0.8.209 (Apache-2.0; puppeteer + headless Chrome; Node ≥22).
