/**
 * Resolve a caption source (SRT/VTT file, inline cues, or transcription segments)
 * into display cues. Shared by the captions tools and the timeline render.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chunkSegments, type CaptionSegment } from "./captions.js";
import { parseSrt, parseStamp, type CaptionStyleName, type SubtitleCue } from "./subtitles.js";

/** An inline cue: `text` (split on newlines) or pre-wrapped `lines`. */
export interface InlineCue {
  start: number;
  end: number;
  text?: string;
  lines?: string[];
}

export interface CueSource {
  /** Segments, `{segments:[…]}` (e.g. the transcribe tool output), or a path to such a JSON file. */
  transcript?: CaptionSegment[] | { segments: CaptionSegment[] } | string;
  /** Path to an .srt file (a .vtt path is also accepted and parsed as WebVTT). */
  srt?: string;
  /** Path to a WebVTT file. */
  vtt?: string;
  /** Inline cues, used as-is (no re-wrapping). */
  cues?: InlineCue[];
  style?: CaptionStyleName;
  maxCharsPerLine?: number;
  maxLines?: number;
}

function segmentsFrom(parsed: unknown): CaptionSegment[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = parsed as any;
  const segments = Array.isArray(p) ? p : p?.segments;
  if (!Array.isArray(segments)) {
    throw new Error("unrecognized transcript JSON: expected an array of segments or {segments:[…]}");
  }
  return segments.map((segment) => {
    if (typeof segment?.start !== "number" || typeof segment?.end !== "number" || typeof segment?.text !== "string") {
      throw new Error('unrecognized transcript segment: each entry needs numeric "start"/"end" and a "text"');
    }
    return segment as CaptionSegment;
  });
}

/** Parse WebVTT text into cues (header, NOTE/STYLE/REGION blocks, cue ids and settings ignored; tags kept). */
export function parseVtt(text: string): SubtitleCue[] {
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  if (!/^WEBVTT/.test(blocks[0]?.trim() ?? "")) throw new Error("invalid WebVTT: missing WEBVTT header");
  const cues: SubtitleCue[] = [];
  for (const block of blocks.slice(1)) {
    const rows = block.split("\n").filter((row) => row.trim() !== "");
    if (rows.length === 0 || /^(NOTE|STYLE|REGION)\b/.test(rows[0])) continue;
    const at = rows.findIndex((row) => row.includes("-->"));
    if (at < 0 || at > 1) throw new Error(`invalid WebVTT block: "${rows[0].trim()}"`);
    const match = /^(\S+)\s*-->\s*(\S+)/.exec(rows[at].trim());
    if (!match) throw new Error(`invalid WebVTT timing line: "${rows[at].trim()}"`);
    const lines = rows.slice(at + 1);
    if (lines.length === 0) throw new Error(`WebVTT cue ${cues.length + 1} has no text`);
    cues.push({ start: parseStamp(match[1]), end: parseStamp(match[2]), lines });
  }
  if (cues.length === 0) throw new Error("no WebVTT cues found");
  return cues;
}

/** Resolve exactly one caption source into cues. */
export async function loadCues(source: CueSource): Promise<SubtitleCue[]> {
  const given = (["transcript", "srt", "vtt", "cues"] as const).filter((k) => source[k] !== undefined);
  if (given.length > 1) throw new Error(`provide only one caption source, not both: ${given.join(" + ")}`);
  if (given.length === 0) throw new Error("provide transcript segments or an srt file path (or inline cues, or a vtt file)");

  if (source.srt !== undefined || source.vtt !== undefined) {
    const path = (source.srt ?? source.vtt)!;
    const text = await readFile(path, "utf8");
    const vtt = source.vtt !== undefined || extname(path).toLowerCase() === ".vtt" || /^\uFEFF?WEBVTT/.test(text);
    return vtt ? parseVtt(text) : parseSrt(text);
  }
  if (source.cues !== undefined) {
    if (source.cues.length === 0) throw new Error("cues is empty");
    return source.cues.map((cue, i) => {
      const lines = cue.lines ?? (cue.text ?? "").split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) throw new Error(`cue ${i + 1} has no text`);
      if (!(cue.end > cue.start)) throw new Error(`cue ${i + 1}: end must be after start`);
      return { start: cue.start, end: cue.end, lines };
    });
  }
  const t = source.transcript!;
  const segments = typeof t === "string" ? segmentsFrom(JSON.parse(await readFile(t, "utf8"))) : segmentsFrom(t);
  const cues = chunkSegments(segments, { maxCharsPerLine: source.maxCharsPerLine, maxLines: source.maxLines });
  if (cues.length === 0) throw new Error("no caption chunks produced from the transcript segments");
  return cues;
}
