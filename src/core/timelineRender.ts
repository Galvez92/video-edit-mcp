import { clipDuration, placeClips, validateTimeline, type Clip, type Timeline, type TransitionType } from "./timeline.js";

/** Timeline transition → ffmpeg xfade transition name. */
const XFADE: Record<TransitionType, string> = {
  crossfade: "fade", dissolve: "dissolve", fadeblack: "fadeblack", fadewhite: "fadewhite",
  wipeleft: "wipeleft", wiperight: "wiperight", slideleft: "slideleft", slideright: "slideright",
};

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
  /** Program time where the overlay starts (s). */
  layerStartSec?: number;
  /** How long the overlay is shown (s); default until it ends. */
  layerDurationSec?: number;
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
  const isVideo = target.kind === "video";
  let gapN = 0;

  if (program) {
    const { placements } = placeClips(program);
    // Items in program order: gaps (black + silence) and chains of clips joined by transitions.
    const items: { v?: string; a: string }[] = [];
    let cursor = 0;
    let chain: { v?: string; a: string; len: number } | undefined;
    const flush = () => {
      if (chain) items.push({ v: chain.v, a: chain.a });
      chain = undefined;
    };
    placements.forEach(({ clip: c, start, end }, k) => {
      const s = info(c);
      const d = clipDuration(c);
      const i = addInput(c);
      let v: string | undefined;
      if (isVideo) {
        if (!s.hasVideo) throw new Error(`clip ${c.id}: ${c.src} has no video stream`);
        const { width: w, height: h, fps } = target as Required<GraphTarget>;
        parts.push(
          `[${i}:v]setpts=PTS-STARTPTS,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,trim=duration=${num(d)}[v${k}]`,
        );
        v = `[v${k}]`;
      }
      if (s.hasAudio) parts.push(`[${i}:a]asetpts=PTS-STARTPTS,${AFMT}${gain(c)},apad,atrim=0:${num(d)}[a${k}]`);
      else parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(d)},${AFMT}[a${k}]`);
      const a = `[a${k}]`;
      if (c.transition && chain) {
        const td = c.transition.durationSec;
        if (isVideo) {
          parts.push(`${chain.v}${v}xfade=transition=${XFADE[c.transition.type]}:duration=${num(td)}:offset=${num(chain.len - td)}[x${k}]`);
          chain.v = `[x${k}]`;
        }
        parts.push(`${chain.a}${a}acrossfade=d=${num(td)}:c1=tri:c2=tri[xa${k}]`);
        chain.a = `[xa${k}]`;
        chain.len += d - td;
      } else {
        flush();
        if (start > cursor + 1e-6) {
          const g = start - cursor;
          const n = gapN++;
          if (isVideo) {
            const { width: w, height: h, fps } = target as Required<GraphTarget>;
            parts.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${num(g)},format=yuv420p,setsar=1[gv${n}]`);
          }
          parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(g)},${AFMT}[ga${n}]`);
          items.push({ v: isVideo ? `[gv${n}]` : undefined, a: `[ga${n}]` });
        }
        chain = { v, a, len: d };
      }
      cursor = end;
    });
    flush();
    duration = cursor;
    const segs = items.map((it) => `${it.v ?? ""}${it.a}`).join("");
    if (isVideo) {
      parts.push(`${segs}concat=n=${items.length}:v=1:a=1[pv][pa]`);
      programVideo = "[pv]";
    } else {
      parts.push(`${segs}concat=n=${items.length}:v=0:a=1[pa]`);
    }
    programAudio = "[pa]";
  }

  const beds: string[] = [];
  music.forEach((t, m) => {
    const { placements } = placeClips(t);
    const segs: string[] = [];
    let end = 0;
    placements.forEach(({ clip: c, start }, k) => {
      const s = info(c);
      if (!s.hasAudio) throw new Error(`clip ${c.id}: ${c.src} has no audio stream`);
      const i = addInput(c);
      const d = clipDuration(c);
      const ms = Math.round(start * 1000);
      // Fades stand in for the crossfade: the incoming clip fades in while the previous one fades out.
      const next = placements[k + 1]?.clip.transition;
      const fin = c.transition ? `,afade=t=in:d=${num(c.transition.durationSec)}` : "";
      const fout = next ? `,afade=t=out:st=${num(d - next.durationSec)}:d=${num(next.durationSec)}` : "";
      parts.push(`[${i}:a]asetpts=PTS-STARTPTS,${AFMT}${gain(c)},atrim=0:${num(d)}${fin}${fout}${ms > 0 ? `,adelay=${ms}:all=1` : ""}[m${m}_${k}]`);
      segs.push(`[m${m}_${k}]`);
      end = Math.max(end, start + d);
    });
    if (!program) duration = Math.max(duration, end);
    if (segs.length === 1) parts.push(`${segs[0]}anull[bed${m}]`);
    else parts.push(`${segs.join("")}amix=inputs=${segs.length}:duration=longest:normalize=0[bed${m}]`);
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
    const st = opts.layerStartSec ?? 0;
    if (st < 0) throw new Error("layerStartSec must be >= 0");
    const shift = st > 0 ? `+${num(st)}/TB` : "";
    const enable = opts.layerDurationSec ? `:enable='between(t,${num(st)},${num(st + opts.layerDurationSec)})'` : "";
    parts.push(`[${o}:v]setpts=PTS-STARTPTS${shift},scale=${w}:${h},format=yuva420p[ov]`);
    parts.push(`${programVideo}[ov]overlay=0:0:eof_action=pass:format=auto${enable},format=yuv420p[vout]`);
    videoOut = "[vout]";
  }

  return {
    inputArgs,
    filterComplex: parts.join(";"),
    maps: [...(videoOut ? [videoOut] : []), audioOut],
    durationSec: duration,
  };
}
