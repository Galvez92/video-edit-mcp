# feat/render-captions
**Status:** draft PR · **Order:** after feat/render-export + feat/captions

## Goal
Wire captions into the final timeline render and the delivery package.

## API
- `render { …, captions?: { srt? | vtt? | cues? | transcript?, style?, maxCharsPerLine?, maxLines?, engine?: "auto"|"hyperframes"|"ffmpeg", srtOutput? } }` → result gains `captions: { engine, cues, style, srt }`; fallback noted in `warnings`.
- `export.package { …, sidecarCaptions? }` — picks up `<video>.srt` when `subtitles` is omitted.

## Decisions
- Burn-in runs after composition (captions above every layer), as a second encode pass using the preset's video args; audio stream-copied.
- `auto` engine prefers HyperFrames (as `captions.render` does) but falls back instead of failing.
- Timeline `caption` tracks remain ignored; captions are passed via `captions`.

## Tests
`tests/render-captions.test.ts`.
