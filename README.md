# video-edit-mcp

[Español](README.es.md) · MIT

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets any assistant edit video locally with ffmpeg.

> Status: early. `main` ships `health` and `probe`; editing tools are on the roadmap.

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
