/**
 * Transcript → caption chunks, and the HyperFrames composition that renders them.
 *
 * The composition is plain HTML/CSS: the producer's runtime seeks the timeline,
 * so every timed element carries `data-start` / `data-duration`, and CSS
 * animations inside an element are timed relative to that element's start.
 */
import {
  type CaptionStyleName,
  type CaptionWord,
  type SubtitleCue,
  wordsByLine,
} from "./subtitles.js";

/** A transcription segment as returned by a speech-to-text step. */
export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
  /** Word-level timings, when the transcriber produced them. */
  words?: CaptionWord[];
}

export interface CaptionChunkOptions {
  maxCharsPerLine?: number;
  maxLines?: number;
}

export const DEFAULT_MAX_CHARS_PER_LINE = 42;
export const DEFAULT_MAX_LINES = 2;

/** Shortest cue we emit, so a degenerate word timing cannot produce an empty range. */
const MIN_CUE_SECONDS = 0.04;

const seconds = (value: number): string => String(Math.round(value * 1000) / 1000);

/**
 * Words of a segment: source timings when one is present per token, otherwise the
 * segment span split proportionally to token length.
 */
export function wordsForSegment(segment: CaptionSegment): CaptionWord[] {
  const tokens = segment.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const given = (segment.words ?? []).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end));
  if (given.length === tokens.length) return given.map((word, index) => ({ ...word, text: tokens[index] }));
  const span = Math.max(0, segment.end - segment.start);
  const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || 1;
  let cursor = segment.start;
  return tokens.map((token) => {
    const start = cursor;
    cursor += span * (token.length / totalChars);
    return { start, end: cursor, text: token };
  });
}

function cue(words: CaptionWord[], lines: string[]): SubtitleCue {
  const start = words[0].start;
  const end = Math.max(words[words.length - 1].end, start + MIN_CUE_SECONDS);
  return { start, end, lines, words };
}

/** Greedy wrap into lines of `maxCharsPerLine`, packed into chunks of `maxLines`. */
function packSegment(words: CaptionWord[], maxCharsPerLine: number, maxLines: number): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let lines: string[] = [];
  let line: CaptionWord[] = [];
  let chunk: CaptionWord[] = [];

  const endLine = (): void => {
    if (line.length > 0) {
      lines.push(line.map((word) => word.text).join(" "));
      line = [];
    }
  };
  const endChunk = (): void => {
    endLine();
    if (chunk.length > 0) cues.push(cue(chunk, lines));
    lines = [];
    chunk = [];
  };

  for (const word of words) {
    const width = [...line, word].reduce((sum, w) => sum + w.text.length, 0) + Math.max(0, line.length);
    // A single over-long word keeps its own line: words are never split.
    if (line.length > 0 && width > maxCharsPerLine) {
      endLine();
      if (lines.length >= maxLines) endChunk();
    }
    line.push(word);
    chunk.push(word);
  }
  endChunk();
  return cues;
}

/** Turn transcription segments into caption chunks that respect the line limits. */
export function chunkSegments(segments: CaptionSegment[], options: CaptionChunkOptions = {}): SubtitleCue[] {
  const maxCharsPerLine = options.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  return segments
    .filter((segment) => segment.text.trim() !== "" && segment.end > segment.start)
    .sort((a, b) => a.start - b.start)
    .flatMap((segment) => packSegment(wordsForSegment(segment), maxCharsPerLine, maxLines));
}

export interface CompositionOptions {
  style?: CaptionStyleName;
  width?: number;
  height?: number;
  /** Composition duration in seconds; defaults to the last cue's end. */
  duration?: number;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function lineHtml(cue: SubtitleCue, style: CaptionStyleName): string {
  const words = cue.words ?? [];
  const perLine = style === "karaoke" && words.length > 0 ? wordsByLine(cue) : [];
  return cue.lines
    .map((line, index) => {
      const tokens = line.split(/\s+/).filter(Boolean);
      const spans = perLine[index];
      const body =
        spans && spans.length === tokens.length
          ? tokens
              .map(
                (token, tokenIndex) =>
                  `<span class="hf-word" style="--hf-delay:${seconds(Math.max(0, spans[tokenIndex].start - cue.start))}s">${escapeHtml(token)}</span>`,
              )
              .join(" ")
          : escapeHtml(line);
      return `<span class="hf-line">${body}</span>`;
    })
    .join("<br>");
}

function cueHtml(cue: SubtitleCue, style: CaptionStyleName): string {
  const duration = Math.max(MIN_CUE_SECONDS, cue.end - cue.start);
  return (
    `  <div class="hf-cue hf-cue--${style}" data-start="${seconds(cue.start)}"` +
    ` data-duration="${seconds(duration)}" data-track-index="0">${lineHtml(cue, style)}</div>`
  );
}

function compositionCss(height: number): string {
  return [
    "  html, body { margin: 0; padding: 0; background: transparent; }",
    "  #hf-captions { position: absolute; inset: 0; overflow: hidden; }",
    "  .hf-cue {",
    "    position: absolute; left: 50%; bottom: 8%; width: 84%; box-sizing: border-box;",
    "    transform: translateX(-50%); text-align: center;",
    "    font-family: system-ui, sans-serif; font-weight: 800; line-height: 1.2;",
    `    font-size: ${Math.max(12, Math.round(height * 0.05))}px;`,
    "    color: #ffffff; text-shadow: 0 0.06em 0.18em rgba(0, 0, 0, 0.75);",
    "  }",
    "  .hf-line { display: inline-block; }",
    "  .hf-cue--box .hf-line { background: rgba(0, 0, 0, 0.62); padding: 0.06em 0.28em; border-radius: 0.14em; }",
    "  .hf-cue--pop { animation: hf-pop 0.18s ease-out both; }",
    "  @keyframes hf-pop {",
    "    from { transform: translateX(-50%) scale(0.72); opacity: 0; }",
    "    to { transform: translateX(-50%) scale(1); opacity: 1; }",
    "  }",
    "  .hf-word { animation: hf-word-in 0.12s linear both; animation-delay: var(--hf-delay, 0s); }",
    "  @keyframes hf-word-in { from { color: #ffffff; } to { color: #ffd400; } }",
  ].join("\n");
}

/** Build a HyperFrames composition (transparent layer) with one timed element per caption chunk. */
export function buildCompositionHtml(cues: SubtitleCue[], options: CompositionOptions = {}): string {
  const width = Math.round(options.width ?? 1080);
  const height = Math.round(options.height ?? 1920);
  const style = options.style ?? "plain";
  const duration = options.duration ?? cues.reduce((max, item) => Math.max(max, item.end), 0);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
${compositionCss(height)}
</style>
</head>
<body>
<div id="hf-captions" data-composition-id="captions" data-width="${width}" data-height="${height}" data-duration="${seconds(duration)}">
${cues.map((item) => cueHtml(item, style)).join("\n")}
</div>
</body>
</html>
`;
}
