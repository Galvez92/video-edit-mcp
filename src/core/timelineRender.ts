import { clipDuration, validateTimeline, type Clip, type Timeline } from "./timeline.js";

/** Target frame/encode settings the graph is built for (a subset of a render preset). */
export interface GraphTarget {
  kind: "video" | "audio";
  width?: number;
  height?: number;
  fps?: number;
}

/** Per-source stream availability, keyed by clip `src`. */
export type SourceInfo = Record<string, { hasVideo: boolean; hasAudio: boolean }>;

export interface TimelineGraph {
  /** ffmpeg input arguments (`-ss/-t/-i ...`), in input-index order. */
  inputArgs: string[];
  filterComplex: string;
  /** Output labels to `-map`. */
  maps: string[];
  durationSec: number;
}

export interface GraphOptions {
  /** Video with alpha (e.g. a HyperFrames webm) laid over the whole program, scaled to the frame. */
  overlay?: string;
}

const AFMT = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
const num = (n: number) => Number(n.toFixed(6)).toString();

/**
 * Build an ffmpeg filter graph for a timeline:
 * - the first `video` track is the program: its clips are trimmed (input `-ss/-t`), fit-and-padded
 *   to the target frame, and concatenated together with their own audio (silence when a clip has none);
 * - every `audio` track is concatenated and mixed under the program audio (clip `gainDb` applies);
 * - `caption` tracks are ignored here (captions are burned by the captions tools / HyperFrames);
 * - an optional alpha `overlay` is scaled to the frame and composited on top.
 * With an `audio` target only the audio graph is built.
 */
export function buildTimelineGraph(tl: Timeline, target: GraphTarget, sources: SourceInfo, opts: GraphOptions = {}): TimelineGraph {
  const errs = validateTimeline(tl);
  if (errs.length) throw new Error(`invalid timeline: ${errs.join("; ")}`);
  const program = tl.tracks.find((t) => t.kind === "video");
  const music = tl.tracks.filter((t) => t.kind === "audio");
  if (target.kind === "video" && !program) throw new Error("timeline needs a video track for a video preset");
  if (!program && music.length === 0) throw new Error("timeline has no video or audio track to render");

  const inputArgs: string[] = [];
  const parts: string[] = [];
  let idx = 0;
  const addInput = (c: Clip) => {
    inputArgs.push("-ss", num(c.in), "-t", num(clipDuration(c)), "-i", c.src);
    return idx++;
  };
  const info = (c: Clip) => {
    const s = sources[c.src];
    if (!s) throw new Error(`no source info for ${c.src}`);
    return s;
  };
  const gain = (c: Clip) => (c.gainDb ? `,volume=${c.gainDb}dB` : "");

  let programAudio: string | undefined;
  let programVideo: string | undefined;
  let duration = 0;

  if (program) {
    const segs: string[] = [];
    program.clips.forEach((c, k) => {
      const s = info(c);
      const d = clipDuration(c);
      duration += d;
      const i = addInput(c);
      if (target.kind === "video") {
        if (!s.hasVideo) throw new Error(`clip ${c.id}: ${c.src} has no video stream`);
        const { width: w, height: h, fps } = target as Required<GraphTarget>;
        parts.push(
          `[${i}:v]setpts=PTS-STARTPTS,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${k}]`,
        );
        segs.push(`[v${k}]`);
      }
      if (s.hasAudio) parts.push(`[${i}:a]asetpts=PTS-STARTPTS,${AFMT}${gain(c)}[a${k}]`);
      else parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(d)},${AFMT}[a${k}]`);
      segs.push(`[a${k}]`);
    });
    const n = program.clips.length;
    if (target.kind === "video") {
      parts.push(`${segs.join("")}concat=n=${n}:v=1:a=1[pv][pa]`);
      programVideo = "[pv]";
    } else {
      parts.push(`${segs.join("")}concat=n=${n}:v=0:a=1[pa]`);
    }
    programAudio = "[pa]";
  }

  const beds: string[] = [];
  music.forEach((t, m) => {
    const segs: string[] = [];
    t.clips.forEach((c, k) => {
      const s = info(c);
      if (!s.hasAudio) throw new Error(`clip ${c.id}: ${c.src} has no audio stream`);
      const i = addInput(c);
      parts.push(`[${i}:a]asetpts=PTS-STARTPTS,${AFMT}${gain(c)}[m${m}_${k}]`);
      segs.push(`[m${m}_${k}]`);
    });
    const len = t.clips.reduce((a, c) => a + clipDuration(c), 0);
    if (!program) duration = Math.max(duration, len);
    parts.push(`${segs.join("")}concat=n=${segs.length}:v=0:a=1[bed${m}]`);
    beds.push(`[bed${m}]`);
  });

  let audioOut: string;
  if (beds.length === 0) audioOut = programAudio!;
  else {
    const ins = [...(programAudio ? [programAudio] : []), ...beds];
    // The program defines the length; music beds are cut (or end early) against it.
    parts.push(`${ins.join("")}amix=inputs=${ins.length}:duration=${programAudio ? "first" : "longest"}:normalize=0[aout]`);
    audioOut = "[aout]";
  }

  let videoOut = programVideo;
  if (programVideo && opts.overlay) {
    const { width: w, height: h } = target as Required<GraphTarget>;
    // libvpx-vp9 decodes the alpha plane of VP9 webm (the native decoder drops it).
    if (/\.webm$/i.test(opts.overlay)) inputArgs.push("-c:v", "libvpx-vp9");
    inputArgs.push("-i", opts.overlay);
    const o = idx++;
    parts.push(`[${o}:v]setpts=PTS-STARTPTS,scale=${w}:${h},format=yuva420p[ov]`);
    parts.push(`${programVideo}[ov]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[vout]`);
    videoOut = "[vout]";
  }

  return {
    inputArgs,
    filterComplex: parts.join(";"),
    maps: [...(videoOut ? [videoOut] : []), audioOut],
    durationSec: duration,
  };
}
