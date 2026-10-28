/**
 * Timeline model shared by editing tools. Times are in seconds.
 * Only types + helpers live on main; operations land in feature branches.
 */
export interface Clip {
  id: string;
  /** Source media path. */
  src: string;
  /** In-point within the source. */
  in: number;
  /** Out-point within the source (exclusive). */
  out: number;
  /** Optional gain in dB for the clip audio. */
  gainDb?: number;
  /** Position on the timeline (seconds). Omitted → right after the previous clip of the track. */
  startSec?: number;
  /** Transition from the previous clip of the same (video/audio) track into this one; the two overlap by `durationSec`. */
  transition?: Transition;
}

export const TRANSITION_TYPES = ["crossfade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideleft", "slideright"] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];
export interface Transition {
  type: TransitionType;
  durationSec: number;
}

/** A clip resolved to its absolute position on the track. */
export interface Placement {
  clip: Clip;
  start: number;
  end: number;
}

const EPS = 1e-6;

/**
 * Resolve clip positions on a track: `startSec` places a clip absolutely (gaps allowed),
 * otherwise it follows the previous clip; a `transition` makes it start `durationSec` before the
 * previous clip ends. Overlaps without a transition are errors.
 */
export function placeClips(t: Track): { placements: Placement[]; errors: string[] } {
  const placements: Placement[] = [];
  const errors: string[] = [];
  let prev: Placement | undefined;
  for (const c of t.clips) {
    const d = clipDuration(c);
    let start = c.startSec ?? (prev ? prev.end : 0);
    if (c.startSec !== undefined && c.startSec < 0) errors.push(`clip ${c.id}: startSec < 0`);
    if (c.transition) {
      const td = c.transition.durationSec;
      if (!prev) errors.push(`clip ${c.id}: transition on the first clip of track ${t.id} (nothing to transition from)`);
      else if (!(td > 0)) errors.push(`clip ${c.id}: transition durationSec must be > 0`);
      else if (td > clipDuration(prev.clip) + EPS || td > d + EPS)
        errors.push(`clip ${c.id}: transition ${td}s is longer than a neighbouring clip (${prev.clip.id} ${clipDuration(prev.clip)}s, ${c.id} ${d}s)`);
      else if (t.kind === "caption") errors.push(`clip ${c.id}: transitions are not supported on caption tracks`);
      else {
        const joined = prev.end - td;
        if (c.startSec !== undefined && Math.abs(c.startSec - joined) > 1e-3)
          errors.push(`clip ${c.id}: startSec ${c.startSec} conflicts with its transition (must be ${joined} or omitted)`);
        start = joined;
      }
    } else if (prev && start < prev.end - EPS && t.kind !== "caption") {
      errors.push(`clip ${c.id}: overlaps clip ${prev.clip.id} on track ${t.id} (${start}s < ${prev.end}s); move it or join them with a transition`);
    }
    prev = { clip: c, start, end: start + d };
    placements.push(prev);
  }
  return { placements, errors };
}

export interface Track {
  id: string;
  kind: "video" | "audio" | "caption";
  clips: Clip[];
}

export interface Timeline {
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
}

export const clipDuration = (c: Clip): number => Math.max(0, c.out - c.in);

/** End of the last clip once positions (startSec, transitions) are resolved. */
export const trackDuration = (t: Track): number => placeClips(t).placements.reduce((m, p) => Math.max(m, p.end), 0);

export const timelineDuration = (tl: Timeline): number =>
  tl.tracks.reduce((m, t) => Math.max(m, trackDuration(t)), 0);

export function validateClip(c: Clip): string[] {
  const errs: string[] = [];
  if (!c.id) errs.push("clip: id is required");
  if (!c.src) errs.push(`clip ${c.id}: src is required`);
  if (c.in < 0) errs.push(`clip ${c.id}: in < 0`);
  if (c.out <= c.in) errs.push(`clip ${c.id}: out must be > in`);
  return errs;
}

/** Every problem that would make a timeline impossible to render, in order. */
export function validateTimeline(tl: Timeline): string[] {
  const errs: string[] = [];
  if (!(tl.width > 0) || !(tl.height > 0)) errs.push("timeline: width and height must be > 0");
  if (!(tl.fps > 0)) errs.push("timeline: fps must be > 0");
  if (tl.tracks.length === 0) errs.push("timeline: at least one track is required");

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const track of tl.tracks) {
    if (trackIds.has(track.id)) errs.push(`track ${track.id}: duplicate id`);
    trackIds.add(track.id);
    if (track.clips.length === 0) errs.push(`track ${track.id}: no clips`);
    for (const clip of track.clips) {
      if (clipIds.has(clip.id)) errs.push(`clip ${clip.id}: duplicate id`);
      clipIds.add(clip.id);
      errs.push(...validateClip(clip));
    }
    errs.push(...placeClips(track).errors);
  }
  return errs;
}
