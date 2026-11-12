/**
 * Interchange import: turn edit decisions made elsewhere (CMX3600 EDL, OpenTimelineIO JSON)
 * into this server's `Timeline`, so the result can be passed straight to `render`.
 * Files are read locally; nothing is downloaded.
 */
import { readFile } from "node:fs/promises";
import { validateTimeline, type Clip, type Timeline, type Track, type Transition } from "./timeline.js";

/** A timeline produced by an import, plus everything the import could not carry over. */
export interface ImportedTimeline extends Timeline {
  /** Non-fatal problems: unmapped reels, skipped nodes, dropped effects. */
  warnings: string[];
}

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_EDL_FPS = 25;
const DEFAULT_OTIO_FPS = 24;

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const geometry = (width?: number, height?: number) => ({ width: width ?? DEFAULT_WIDTH, height: height ?? DEFAULT_HEIGHT });
const errnoMessage = (err: unknown): string =>
  (err as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : (err as Error).message;

/** Validate what we built and hand it back with its warnings. */
function finish(source: string, tl: Timeline, warnings: string[]): ImportedTimeline {
  const errors = validateTimeline(tl);
  if (errors.length) throw new Error(`${source}: import produced an invalid timeline: ${errors.slice(0, 5).join("; ")}`);
  return { ...tl, warnings };
}

// ---------------------------------------------------------------- CMX3600 EDL

const TIMECODE = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/;

/** `HH:MM:SS:FF` (or `HH:MM:SS;FF`) at `fps` → seconds. */
function timecodeSeconds(tc: string, fps: number, where: string): number {
  const m = TIMECODE.exec(tc);
  if (!m) throw new Error(`${where}: invalid timecode "${tc}" (expected HH:MM:SS:FF)`);
  const frames = Number(m[4]);
  if (frames >= Math.ceil(fps)) throw new Error(`${where}: frame ${frames} is out of range for ${fps} fps`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frames / fps;
}

export interface EdlEvent {
  line: number;
  /** Event number as written in the EDL (used to keep clip ids stable). */
  number: string;
  reel: string;
  track: string;
  srcIn: number;
  srcOut: number;
  recIn: number;
  recOut: number;
  /** Dissolve duration, when the event opens with one. */
  transition?: Pick<Transition, "type" | "durationSec">;
}

export interface EdlDoc {
  title?: string;
  events: EdlEvent[];
  warnings: string[];
}

/**
 * Parse a CMX3600 EDL: `NNN REEL TRACK TRANS SRC_IN SRC_OUT REC_IN REC_OUT` per event line.
 * Comments (`*`) and header lines (`TITLE:`, `FCM:`, `AUD`) are skipped.
 */
export function parseEdl(text: string, fps = DEFAULT_EDL_FPS): EdlDoc {
  const events: EdlEvent[] = [];
  const warnings: string[] = [];
  let title: string | undefined;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const where = `EDL line ${i + 1}`;
    if (!line || line.startsWith("*")) return;
    if (/^TITLE:/i.test(line)) {
      title = line.slice(line.indexOf(":") + 1).trim();
      return;
    }
    const m = /^(\d{3,})\s+(.+)$/.exec(line);
    if (!m) return; // header/metadata line, not an event
    const tokens = m[2].trim().split(/\s+/);
    if (tokens.length < 6) throw new Error(`${where}: incomplete event (expected REEL TRACK TRANS and 4 timecodes)`);

    const [srcIn, srcOut, recIn, recOut] = tokens.slice(-4).map((tc) => timecodeSeconds(tc, fps, where));
    const [reel, track] = [tokens[0], tokens[1]];
    const transitionTokens = tokens.slice(2, tokens.length - 4);
    const kind = (transitionTokens[0] ?? "C").toUpperCase();
    let transition: EdlEvent["transition"];
    if (kind === "D" || kind === "DISSOLVE") {
      const frames = Number(transitionTokens[1] ?? NaN);
      if (frames > 0) transition = { type: "crossfade", durationSec: round(frames / fps) };
    } else if (kind !== "C" && kind !== "CUT") {
      warnings.push(`${where}: transition "${kind}" imported as a cut`);
    }

    if (srcOut <= srcIn) throw new Error(`${where}: source out ${srcOut}s is not after in ${srcIn}s`);
    if (recOut <= recIn) throw new Error(`${where}: record out ${recOut}s is not after in ${recIn}s`);
    events.push({ line: i + 1, number: m[1], reel, track, srcIn, srcOut, recIn, recOut, transition });
  });

  if (!events.length) throw new Error("EDL: no events found (expected CMX3600 event lines)");
  return { title, events, warnings };
}

/** EDL track token → timeline tracks: V/B are video, A/A2/AA are audio, AA/V is both. */
function edlTracks(token: string): { kind: "video" | "audio"; id: string }[] {
  const t = token.toUpperCase();
  const channel = /(\d+)/.exec(t)?.[1] ?? "1";
  const out: { kind: "video" | "audio"; id: string }[] = [];
  if (t.includes("V") || t === "B") out.push({ kind: "video", id: `v${channel}` });
  if (t.includes("A")) out.push({ kind: "audio", id: `a${channel}` });
  return out;
}

export interface EdlImportOptions {
  path: string;
  /** Frame rate the timecodes are counted in (default 25). */
  fps?: number;
  /** Reel name → local media path. Reels left out are used as the source path as written. */
  mediaMap?: Record<string, string>;
  width?: number;
  height?: number;
}

/** Read a CMX3600 EDL and place its events on a timeline at their record positions. */
export async function importEdl(opts: EdlImportOptions): Promise<ImportedTimeline> {
  const fps = opts.fps ?? DEFAULT_EDL_FPS;
  let text: string;
  try {
    text = await readFile(opts.path, "utf8");
  } catch (err) {
    throw new Error(`EDL ${opts.path}: ${errnoMessage(err)}`, { cause: err });
  }

  const doc = parseEdl(text, fps);
  const warnings = [...doc.warnings];
  const tracks = new Map<string, Track>();
  const unmapped = new Set<string>();

  for (const ev of doc.events) {
    const targets = edlTracks(ev.track);
    if (!targets.length) {
      warnings.push(`EDL line ${ev.line}: track "${ev.track}" is neither video nor audio; skipped`);
      continue;
    }
    const src = opts.mediaMap?.[ev.reel];
    if (!src) unmapped.add(ev.reel);

    for (const target of targets) {
      let track = tracks.get(target.id);
      if (!track) {
        track = { id: target.id, kind: target.kind, clips: [] };
        tracks.set(target.id, track);
      }
      const clip: Clip = { id: `${target.id}-${ev.number}`, src: src ?? ev.reel, in: round(ev.srcIn), out: round(ev.srcOut) };
      if (track.clips.length === 0) {
        if (ev.transition) warnings.push(`EDL line ${ev.line}: transition on the first clip of ${target.id} ignored`);
        clip.startSec = round(ev.recIn);
      } else if (ev.transition) {
        clip.transition = ev.transition; // placed by the transition, overlapping the previous clip
      } else {
        clip.startSec = round(ev.recIn);
      }
      if (Math.abs(ev.recOut - ev.recIn - (ev.srcOut - ev.srcIn)) > 1e-3)
        warnings.push(
          `EDL line ${ev.line}: record duration ${round(ev.recOut - ev.recIn)}s differs from source duration ${round(ev.srcOut - ev.srcIn)}s (speed changes are not imported)`,
        );
      track.clips.push(clip);
    }
  }

  for (const reel of unmapped) warnings.push(`reel "${reel}" is not in mediaMap: used as the source path as written`);
  const tl: Timeline = { ...geometry(opts.width, opts.height), fps, tracks: [...tracks.values()] };
  if (!tl.tracks.length) throw new Error("EDL: no video or audio events to import");
  return finish("EDL", tl, warnings);
}

// --------------------------------------------------------- OpenTimelineIO JSON

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const schemaOf = (v: unknown): string => (isObject(v) ? String(v.OTIO_SCHEMA ?? "") : "");
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** RationalTime → seconds (and its rate, used to infer the timeline fps). */
function rational(v: unknown): { seconds: number; rate: number } | undefined {
  if (!isObject(v)) return undefined;
  const value = finite(v.value);
  const rate = finite(v.rate);
  if (value === undefined || rate === undefined || rate <= 0) return undefined;
  return { seconds: value / rate, rate };
}

/** A clip/gap's source_range → in-point and duration on the source. */
function rangeOf(node: Json): { inSec: number; durationSec: number; rate?: number } | undefined {
  const range = node.source_range;
  if (!isObject(range)) return undefined;
  const start = rational(range.start_time);
  const duration = rational(range.duration);
  if (!duration) return undefined;
  return { inSec: start?.seconds ?? 0, durationSec: duration.seconds, rate: duration.rate };
}

/** Media path of a clip: `media_references.DEFAULT_MEDIA` (Clip.2) or `media_reference` (older files). */
function mediaPath(node: Json): string | undefined {
  const refs = node.media_references;
  const ref = isObject(refs) && isObject(refs.DEFAULT_MEDIA) ? refs.DEFAULT_MEDIA : isObject(node.media_reference) ? node.media_reference : undefined;
  const url = ref && typeof ref.target_url === "string" ? ref.target_url : undefined;
  return url ? url.replace(/^file:\/\//, "") : undefined;
}

export interface OtioImportOptions {
  path: string;
  width?: number;
  height?: number;
}

/** Read an OpenTimelineIO JSON file and lay its video/audio track children out in order. */
export async function importOtio(opts: OtioImportOptions): Promise<ImportedTimeline> {
  let text: string;
  try {
    text = await readFile(opts.path, "utf8");
  } catch (err) {
    throw new Error(`OTIO ${opts.path}: ${errnoMessage(err)}`, { cause: err });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`OTIO ${opts.path}: invalid JSON (${(err as Error).message})`, { cause: err });
  }
  if (!isObject(doc)) throw new Error(`OTIO ${opts.path}: expected a JSON object`);

  const stack = isObject(doc.tracks) ? doc.tracks : schemaOf(doc).startsWith("Stack") ? doc : undefined;
  if (!stack) throw new Error(`OTIO ${opts.path}: no "tracks" stack found`);
  const children = Array.isArray(stack.children) ? stack.children : [];
  if (!children.length) throw new Error(`OTIO ${opts.path}: the tracks stack is empty`);

  const warnings: string[] = [];
  const rates = new Map<number, number>();
  const countRate = (rate?: number) => {
    if (rate) rates.set(rate, (rates.get(rate) ?? 0) + 1);
  };

  const tracks: Track[] = [];
  for (const child of children) {
    const name = isObject(child) ? String(child.name ?? "") : "";
    const kindRaw = isObject(child) ? String(child.kind ?? "").toLowerCase() : "";
    const kind = kindRaw === "video" ? "video" : kindRaw === "audio" ? "audio" : undefined;
    if (!isObject(child) || !schemaOf(child).startsWith("Track") || !kind) {
      warnings.push(`skipped ${name || schemaOf(child) || "unknown node"}: only video and audio tracks are imported`);
      continue;
    }

    const base = kind === "video" ? "v" : "a";
    let index = 1;
    while (tracks.some((t) => t.id === `${base}${index}`)) index += 1;
    const track: Track = { id: `${base}${index}`, kind, clips: [] };
    let cursor = 0;
    for (const node of Array.isArray(child.children) ? child.children : []) {
      if (!isObject(node)) continue;
      const schema = schemaOf(node);
      const range = rangeOf(node);
      if (schema.startsWith("Gap")) {
        cursor += range?.durationSec ?? 0; // gaps keep their place; they are not rendered as clips
        continue;
      }
      if (!schema.startsWith("Clip")) {
        warnings.push(`track ${track.id}: skipped ${schema || "unknown node"}`);
        continue;
      }
      const label = String(node.name ?? "") || "clip";
      if (!range) {
        warnings.push(`track ${track.id}: ${label} has no usable source_range; skipped`);
        continue;
      }
      const src = mediaPath(node);
      if (!src) {
        warnings.push(`track ${track.id}: ${label} has no media reference; skipped`);
        continue;
      }
      countRate(range.rate);
      track.clips.push({
        id: `${track.id}-${track.clips.length + 1}`,
        src,
        in: round(range.inSec),
        out: round(range.inSec + range.durationSec),
        startSec: round(cursor),
      });
      cursor += range.durationSec;
    }

    if (!track.clips.length) {
      warnings.push(`track ${track.id}: no clips imported; dropped`);
      continue;
    }
    tracks.push(track);
  }

  if (!tracks.length) throw new Error(`OTIO ${opts.path}: no clips found on video/audio tracks`);

  let fps = DEFAULT_OTIO_FPS;
  if (rates.size) {
    fps = [...rates.entries()].sort((a, b) => b[1] - a[1])[0][0];
  } else {
    warnings.push(`no frame rate found in the timeline: assuming ${DEFAULT_OTIO_FPS} fps`);
  }

  return finish("OTIO", { ...geometry(opts.width, opts.height), fps, tracks }, warnings);
}
