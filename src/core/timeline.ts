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

export const trackDuration = (t: Track): number => t.clips.reduce((acc, c) => acc + clipDuration(c), 0);

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
  }
  return errs;
}
