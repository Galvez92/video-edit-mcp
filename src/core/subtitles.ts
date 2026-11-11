/**
 * Caption text/timing model plus SRT and ASS interchange.
 * Pure: no I/O, no engine, no ffmpeg — both engines render from the same cues.
 */

/** One timed word, as produced by transcription (word-level timestamps). */
export interface CaptionWord {
  start: number;
  end: number;
  text: string;
}

/** One caption chunk: a time range plus the display lines rendered inside it. */
export interface SubtitleCue {
  start: number;
  end: number;
  /** Display lines, already wrapped for the screen. */
  lines: string[];
  /** Word timings, when the source carries them (karaoke needs these). */
  words?: CaptionWord[];
}

/** `plain` static, `karaoke` word highlight, `pop` scale-in, `box` background plate. */
export type CaptionStyleName = "plain" | "karaoke" | "pop" | "box";

const pad = (value: number, width = 2): string => String(Math.trunc(value)).padStart(width, "0");

/** Seconds → SRT stamp `HH:MM:SS,mmm`. */
export function toSrtTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const secs = Math.floor(totalMs / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(totalMs % 1000, 3)}`;
}

/** Seconds → ASS stamp `H:MM:SS.cc`. */
export function toAssTime(seconds: number): string {
  const totalCs = Math.round(Math.max(0, seconds) * 100);
  const hours = Math.floor(totalCs / 360_000);
  const minutes = Math.floor(totalCs / 6000) % 60;
  const secs = Math.floor(totalCs / 100) % 60;
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(totalCs % 100)}`;
}

const STAMP = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]?\d)[.,](\d{1,3})$/;

/** Parse an SRT (`HH:MM:SS,mmm`) or ASS (`H:MM:SS.cc`) stamp into seconds. */
export function parseStamp(value: string): number {
  const match = STAMP.exec(value.trim());
  if (!match) throw new Error(`invalid time stamp: "${value.trim()}"`);
  const [, hours, minutes, seconds, fraction] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`);
}

/**
 * Parse SRT text into cues. Inline styling tags stay in the text (the ASS writer
 * drops them) and cue settings after the end stamp are ignored.
 */
export function parseSrt(text: string): SubtitleCue[] {
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const rows = block.split("\n").filter((row) => row.trim() !== "");
    if (rows.length === 0) continue;
    const offset = /^\d+$/.test(rows[0].trim()) ? 1 : 0;
    const timing = rows[offset];
    if (timing === undefined) throw new Error(`invalid SRT block: missing timing line ("${rows[0].trim()}")`);
    const arrow = timing.indexOf("--" + ">");
    const match = arrow < 0 ? null : ["", timing.slice(0, arrow).trim(), timing.slice(arrow + 3).trim().split(/\s+/)[0] ?? ""];
    if (!match) throw new Error(`invalid SRT timing line: "${timing.trim()}"`);
    const lines = rows.slice(offset + 1);
    if (lines.length === 0) throw new Error(`SRT cue ${cues.length + 1} has no text`);
    cues.push({ start: parseStamp(match[1]), end: parseStamp(match[2]), lines });
  }
  if (cues.length === 0) throw new Error("no SRT cues found");
  return cues;
}

/** Render cues as SRT: numbered blocks, `HH:MM:SS,mmm`, one blank line between. */
export function formatSrt(cues: SubtitleCue[]): string {
  const blocks = cues.map(
    (cue, index) => `${index + 1}\n${toSrtTime(cue.start)} --> ${toSrtTime(cue.end)}\n${cue.lines.join("\n")}`,
  );
  return `${blocks.join("\n\n")}\n`;
}

/** Group a cue's word timings by display line (chunking emits lines and words in the same order). */
export function wordsByLine(cue: SubtitleCue): CaptionWord[][] {
  const words = cue.words ?? [];
  let index = 0;
  return cue.lines.map((line) => {
    const count = line.split(/\s+/).filter(Boolean).length;
    const slice = words.slice(index, index + count);
    index += count;
    return slice;
  });
}

/** Number of whitespace-separated tokens across all lines of a cue. */
export const tokenCount = (cue: SubtitleCue): number =>
  cue.lines.reduce((total, line) => total + line.split(/\s+/).filter(Boolean).length, 0);

interface AssStyleSpec {
  borderStyle: number;
  outline: number;
  shadow: number;
  backColour: string;
  secondaryColour: string;
}

const WHITE = "&H00FFFFFF";
/** ASS colours are `&HAABBGGRR`; this is #FFD400, the same highlight the composition uses. */
const HIGHLIGHT = "&H0000D4FF";
const OUTLINE = "&H00101010";

/** ASS approximations of the composition styles, used by the ffmpeg fallback. */
const ASS_STYLES: Record<CaptionStyleName, AssStyleSpec> = {
  plain: { borderStyle: 1, outline: 4, shadow: 1, backColour: "&H80000000", secondaryColour: WHITE },
  karaoke: { borderStyle: 1, outline: 4, shadow: 1, backColour: "&H80000000", secondaryColour: HIGHLIGHT },
  pop: { borderStyle: 1, outline: 4, shadow: 1, backColour: "&H80000000", secondaryColour: WHITE },
  box: { borderStyle: 3, outline: 12, shadow: 0, backColour: "&H80000000", secondaryColour: WHITE },
};

export interface AssOptions {
  style?: CaptionStyleName;
  width?: number;
  height?: number;
  fontName?: string;
}

/** Drop pre-existing override tags, then escape ASS-special characters. */
const escapeAss = (text: string): string =>
  text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .trim();

/** Inline ASS override tags approximating the requested style, plus the cue text. */
function assText(cue: SubtitleCue, style: CaptionStyleName): string {
  const prefix = style === "pop" ? "{\\fscx72\\fscy72\\t(0,160,\\fscx100\\fscy100)}" : "";
  const words = cue.words ?? [];
  if (style === "karaoke" && words.length > 0 && words.length === tokenCount(cue)) {
    const text = wordsByLine(cue)
      .map((line) =>
        line
          .map((word) => `{\\k${Math.max(1, Math.round((Math.max(word.end, word.start) - word.start) * 100))}}${escapeAss(word.text)}`)
          .join(" "),
      )
      .join("\\N");
    return `${prefix}${text}`;
  }
  const stripped = cue.lines.map(stripTags);
  return `${prefix}${stripped.map(escapeAss).join("\\N")}`;
}

/** Render cues as an ASS script (v4.00+), including the style table for the requested caption style. */
export function formatAss(cues: SubtitleCue[], options: AssOptions = {}): string {
  const width = Math.round(options.width ?? 1080);
  const height = Math.round(options.height ?? 1920);
  const style = options.style ?? "plain";
  const spec = ASS_STYLES[style];
  const fontSize = Math.max(12, Math.round(height * 0.05));
  const marginX = Math.round(width * 0.06);
  const marginV = Math.round(height * 0.1);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${options.fontName ?? "DejaVu Sans"},${fontSize},${WHITE},${spec.secondaryColour},${OUTLINE},${spec.backColour},0,0,0,0,100,100,0,0,${spec.borderStyle},${spec.outline},${spec.shadow},2,${marginX},${marginX},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Caption,,0,0,0,,${assText(cue, style)}`,
  );
  return `${[...header, ...events].join("\n")}\n`;
}

/** Remove markup tags repeatedly until stable, then drop any stray angle brackets. */
function stripTags(line: string): string {
  let prev: string;
  let out = line;
  do {
    prev = out;
    out = out.replace(/<[^<>]*>/g, "");
  } while (out !== prev);
  return out.replace(/[<>]/g, "");
}
