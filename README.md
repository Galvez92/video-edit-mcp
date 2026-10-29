# video-edit-mcp

[Español](README.es.md) · MIT

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets any assistant edit video locally with ffmpeg.

Cut, trim, join, reframe, caption, mix and render video from any MCP client (Claude Desktop, Cursor, …). Everything runs on your machine: ffmpeg for cut/mix/encode, optional [HyperFrames](https://github.com/heygen-com/hyperframes) for animated captions and composition, optional local Whisper for transcription. No cloud calls, no API keys.

## Install
Requirements: Node 22+, `ffmpeg` and `ffprobe` on `PATH`.
Optional: `@hyperframes/producer` + headless Chrome (animated captions, `compose`, HTML layers; ffmpeg fallback otherwise), a Whisper CLI (`whisper.cpp` or `faster-whisper`/`whisper-ctranslate2`) for `transcribe`.

```bash
git clone https://github.com/Galvez92/video-edit-mcp.git
cd video-edit-mcp
npm ci && npm run build
node dist/index.js                     # stdio
node dist/index.js --http --port 3333  # Streamable HTTP at http://127.0.0.1:3333/mcp
```

## MCP client config
**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`) use the same shape:
```json
{
  "mcpServers": {
    "video-edit": {
      "command": "node",
      "args": ["/absolute/path/to/video-edit-mcp/dist/index.js"]
    }
  }
}
```
All paths passed to tools are local file paths on the machine running the server.

## Tools
| Tool | What it does |
|---|---|
| `health` | ffmpeg / ffprobe / Whisper availability and versions |
| `probe` | Container, duration, size and per-stream info of a media file |
| `trim` | Keep one range; stream copy when keyframe-safe, re-encode otherwise |
| `cut` | Keep several ranges of one file and join them in order |
| `concat` | Join files into one, normalizing resolution / fps / audio |
| `render` | Encode a file or a multi-track timeline with a preset (`web-1080p`, `vertical-9x16`, `square`, `audio-only`); transitions, stills + Ken Burns, overlay/HTML layers, burned-in captions, loudness normalization |
| `export.package` | Delivery ZIP: media, `captions.srt`, `spec.json` (measured specs + EBU R128 loudness) and `checksums.sha256` |
| `compose` | Render a HyperFrames HTML composition to video (optional peer) |
| `transcribe` | Local Whisper transcription with word timestamps |
| `captions.generate` | Transcript/SRT → SRT, ASS or animated HyperFrames captions (`plain`, `karaoke`, `pop`, `box`) |
| `captions.render` | Burn captions into a video (HyperFrames or ffmpeg/libass), audio kept |
| `reframe` | Reframe to 9:16, 1:1, 16:9 or 4:5: crop (focus point or subject follow), color pad or blurred pad |
| `audio.measure` | Integrated loudness (LUFS), true peak and LRA |
| `audio.loudnorm` | Two-pass loudness normalization (default −14 LUFS) |
| `audio.mix` | Voice + music with sidechain ducking and fades, video stream-copied |

## End-to-end example
Ask your assistant, or call the tools directly:
1. `probe { "path": "talk.mp4" }`
2. `transcribe { "input": "talk.mp4", "wordTimestamps": true }` → segments
3. `render` a 9:16 cut with burned-in captions and normalized audio:
```json
{ "preset": "vertical-9x16", "output": "out/final.mp4",
  "timeline": { "width": 1080, "height": 1920, "fps": 30, "tracks": [
    { "id": "v", "kind": "video", "clips": [
      { "id": "a", "src": "talk.mp4", "in": 12, "out": 27 },
      { "id": "b", "src": "talk.mp4", "in": 40, "out": 52, "transition": { "type": "crossfade", "durationSec": 0.5 } } ] },
    { "id": "m", "kind": "audio", "clips": [
      { "id": "music", "src": "music.m4a", "in": 0, "out": 26.5, "gainDb": -14 } ] } ] },
  "captions": { "transcript": "talk.transcript.json", "style": "box" },
  "loudness": {} }
```
4. `export.package { "video": "out/final.mp4", "output": "out/final.zip", "preset": "vertical-9x16" }` → ZIP with the video, `captions.srt`, `spec.json` and checksums.

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
`render` and `export.package` accept `loudness: { targetLufs?: -16, truePeakDb?: -1, lra?: 11 }`. **Off by default**; pass `{}` for the defaults. Two-pass ffmpeg `loudnorm` on the final mix (after captions): pass 1 measures, pass 2 applies the measured values (`linear` gain when the true-peak ceiling allows it, otherwise `limited`: gain + 4x-oversampled limiter with up to 3 measured gain corrections, because loudnorm dynamic undershoots on short mixes). Video is stream-copied.
- `render` returns `loudness: { target, before, after, mode }` and writes `<output>.loudness.json`; `export.package` copies it into `spec.json` as `loudnessNormalization` (only while its checksum matches the file).
- `export.package { loudness }` normalizes a copy before packaging; the source file is untouched. `spec.loudness` is always measured on the packaged file.

## Roadmap
- EDL / OTIO import
- Published npm package

## Development
```bash
npm test        # ffmpeg tests skip if ffmpeg is missing
npm run lint && npm run typecheck
```
See [AGENTS.md](AGENTS.md) for conventions.

## Third-party
- [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0) — optional peer dependency used as the composition/captions engine.
- ffmpeg — invoked as an external binary.
