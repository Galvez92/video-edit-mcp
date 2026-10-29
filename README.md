# video-edit-mcp

[Español](README.es.md) · MIT

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets any assistant edit video locally with ffmpeg.

> Status: early. `main` ships `health` and `probe`; `trim`, `cut` and `concat` are landing from `feat/core-ffmpeg`.

## Quick start
Requirements: Node 22+, ffmpeg + ffprobe on `PATH`.

```bash
npm ci && npm run build
node dist/index.js                     # stdio
node dist/index.js --http --port 3333  # Streamable HTTP at http://127.0.0.1:3333/mcp
```

MCP client config (stdio):
```json
{ "mcpServers": { "video-edit": { "command": "node", "args": ["/path/to/video-edit-mcp/dist/index.js"] } } }
```

## Tools
| Tool | Description |
|---|---|
| `health` | ffmpeg / ffprobe availability and versions |
| `probe` | Container, duration and stream info of a local file |
| `trim` | Keep one range of a file; stream copy when keyframe-safe, re-encode otherwise |
| `cut` | Keep several ranges of one file and join them in order |
| `concat` | Join files into one, normalizing resolution/fps/audio |

## Timeline layer sizing
`render` layers keep their source aspect ratio: `scale` (fraction of frame width, or `scaleMode: "native"`), or `width`/`height` in px (one keeps aspect). When both `width` and `height` are given, `fit` defaults to `contain` (fit inside the box, centred); use `cover` to fill and crop, or `fit: "stretch"` explicitly to distort to the exact box. A layer with no size fills the frame. Off-frame positions are clamped and reported in `warnings`.

## Captions in the final render
`render` accepts `captions` and burns them in **after** the timeline and layers are composed (times are program seconds):

```json
{ "timeline": { ... }, "preset": "vertical-9x16", "output": "out/final.mp4",
  "captions": { "srt": "subs.srt", "style": "box", "engine": "auto" } }
```

- Source (exactly one): `srt` (path; `.vtt` detected), `vtt` (path), `cues` (`[{start,end,text}]`), or `transcript` (segments, the `transcribe` output object, or a JSON path).
- `style`: `plain` | `karaoke` | `pop` | `box`; `maxCharsPerLine` / `maxLines` wrap transcripts.
- `engine`: `auto` (default: HyperFrames when the optional peer is installed, otherwise ffmpeg/libass with a warning), `hyperframes` or `ffmpeg`. The burn-in pass encodes with the preset's video settings and copies the audio.
- The SRT actually burned is written next to the output (`final.srt`, or `srtOutput`) and reported in `captions.srt`. `export.package` includes that sidecar as `captions.srt` when `subtitles` is omitted (`sidecarCaptions: false` to skip).

## Still images on the timeline
A video-track clip whose `src` is a `.png`, `.jpg`/`.jpeg` or `.webp` is a still: pass `durationSec` (no `in`/`out`). It is framed to the preset (`still.fit`: `contain`, the default, pads; `cover` fills and crops), carries silent audio and joins neighbours with any transition.
```json
{ "id": "title", "src": "poster.jpg", "durationSec": 3,
  "still": { "fit": "cover", "kenBurns": { "zoomFrom": 1, "zoomTo": 1.25, "from": { "x": 0.3, "y": 0.5 }, "to": { "x": 0.6, "y": 0.4 } } } }
```
Ken Burns is optional: zoom 1..4 and a focus point (0..1 of the frame) interpolated linearly over the clip. Stills are not allowed on audio tracks.

`render` also returns `program: { durationSec, clipsSec, overlapSec, gapSec }`: the effective program length is the sum of clips minus transition overlaps plus gaps (each transition shortens the program by its `durationSec`).

## Loudness normalization
`render` and `export.package` accept `loudness: { targetLufs?: -16, truePeakDb?: -1, lra?: 11 }`. **Off by default**; pass `{}` for the defaults. Two-pass ffmpeg `loudnorm` on the final mix (after captions): pass 1 measures, pass 2 applies the measured values (`linear` gain when the true-peak ceiling allows it, otherwise loudnorm switches to `dynamic` and the result says so). Video is stream-copied.
- `render` returns `loudness: { target, before, after, mode }` and writes `<output>.loudness.json`; `export.package` copies it into `spec.json` as `loudnessNormalization` (only while its checksum matches the file).
- `export.package { loudness }` normalizes a copy before packaging; the source file is untouched. `spec.loudness` is always measured on the packaged file.

## Roadmap
1. Cut / trim / concat / assemble timeline
2. Local transcription (Whisper) · animated captions rendered with HyperFrames (SRT/ASS export + ffmpeg fallback) · reframe 9:16/1:1/16:9 · audio mix, ducking, loudnorm −16 LUFS
3. HyperFrames composition (overlays, titles) + ffmpeg render presets + ZIP export (video + SRT + spec.json)
4. EDL / OTIO import

## Development
```bash
npm test        # ffmpeg tests skip if ffmpeg is missing
npm run lint && npm run typecheck
```
See [AGENTS.md](AGENTS.md) for conventions.

## Third-party
- [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0) — optional peer dependency used as the composition/captions engine.
- ffmpeg — invoked as an external binary.
