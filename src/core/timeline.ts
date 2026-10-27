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
  if (c.in < 0) errs.push(`clip ${c.id}: in < 0`);
  if (c.out <= c.in) errs.push(`clip ${c.id}: out must be > in`);
  return errs;
}
