import { AFADE_CURVE, clipDuration, placeClips, validateTimeline, type AudioCurve, type Clip, type Timeline, type TransitionType } from "./timeline.js";

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
  /** Non-fatal layout notes (e.g. a layer clamped into the frame). */
  warnings: string[];
}

/** One alpha video layer composited over the program. */
export interface GraphLayer {
  /** Video with alpha (e.g. a HyperFrames webm / ProRes 4444 mov). */
  src: string;
  /** Program time where the layer starts (s). Default 0. */
  startSec?: number;
  /** How long it is shown (s); default until the layer ends. */
  durationSec?: number;
  /** Stacking order: higher is on top. Ties keep array order. Default: array index. */
  zIndex?: number;
  /** Top-left position in output pixels. Default 0,0. */
  x?: number;
  y?: number;
  /**
   * Uniform size factor; the layer always keeps its source aspect ratio.
   * `scaleMode: "frame-width"` (default): layer width = scale × frame width (0 < scale <= 1).
   * `scaleMode: "native"`: layer size = scale × the source's own pixel size (0 < scale <= 10).
   */
  scale?: number;
  scaleMode?: LayerScaleMode;
  /** Target width/height in output px. One of them keeps the source aspect; both = an explicit box (see `fit`). */
  width?: number;
  height?: number;
  /**
   * How the source fills an explicit box (width+height, or the full frame when no size is given):
   * `stretch` (default, exact box), `contain` (fit inside, centred, keeps aspect), `cover` (fill and crop, keeps aspect).
   */
  fit?: LayerFit;
  /** Source pixel size (filled in by `render` from ffprobe). Without it the source is assumed to have the frame's aspect. */
  srcWidth?: number;
  srcHeight?: number;
  /** Alpha fade-in at the layer start (s). */
  fadeInSec?: number;
  /** Alpha fade-out before the layer end (s); needs `durationSec`. */
  fadeOutSec?: number;
  /** Entry motion from off-frame (slide) or from zero size (scale) into place. */
  enter?: LayerMotion;
  /** Exit motion out of frame (slide) or down to zero size (scale); needs `durationSec`. */
  exit?: LayerMotion;
}

export const LAYER_SCALE_MODES = ["frame-width", "native"] as const;
export type LayerScaleMode = (typeof LAYER_SCALE_MODES)[number];
export const LAYER_FITS = ["contain", "cover", "stretch"] as const;
export type LayerFit = (typeof LAYER_FITS)[number];

export interface LayerLayout {
  /** Scaled source size before any crop. */
  sw: number;
  sh: number;
  /** Final on-frame size (after a `cover` crop). */
  w: number;
  h: number;
  x: number;
  y: number;
  crop: boolean;
  warnings: string[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Resolve a layer's on-frame size and position (aspect kept unless `stretch` with an explicit box), clamping it into the frame. */
export function layoutLayer(l: GraphLayer, W: number, H: number, label = "layer"): LayerLayout {
  const srcW = l.srcWidth && l.srcWidth > 0 ? l.srcWidth : W;
  const srcH = l.srcHeight && l.srcHeight > 0 ? l.srcHeight : H;
  const ar = srcW / srcH;
  const warnings: string[] = [];
  let sw: number, sh: number;
  let boxW: number | undefined, boxH: number | undefined;
  if (l.width !== undefined && l.height !== undefined) [boxW, boxH] = [l.width, l.height];
  else if (l.width !== undefined) [sw, sh] = [l.width, l.width / ar];
  else if (l.height !== undefined) [sw, sh] = [l.height * ar, l.height];
  else if (l.scale !== undefined) {
    if ((l.scaleMode ?? "frame-width") === "native") [sw, sh] = [srcW * l.scale, srcH * l.scale];
    else [sw, sh] = [W * l.scale, (W * l.scale) / ar];
  } else [boxW, boxH] = [W, H]; // no size: fill the frame (previous behaviour)
  let w: number, h: number;
  let offX = 0, offY = 0, crop = false;
  if (boxW !== undefined && boxH !== undefined) {
    const fit = l.fit ?? "stretch";
    if (fit === "stretch") [sw, sh] = [boxW, boxH];
    else {
      const k = fit === "contain" ? Math.min(boxW / srcW, boxH / srcH) : Math.max(boxW / srcW, boxH / srcH);
      [sw, sh] = [srcW * k, srcH * k];
      if (fit === "contain") [offX, offY] = [(boxW - sw) / 2, (boxH - sh) / 2];
      else crop = true;
    }
    sw = even(sw); sh = even(sh);
    [w, h] = crop ? [even(boxW), even(boxH)] : [sw, sh];
  } else {
    sw = even(sw!); sh = even(sh!);
    [w, h] = [sw, sh];
  }
  let x = Math.round((l.x ?? 0) + offX);
  let y = Math.round((l.y ?? 0) + offY);
  if (w > W || h > H) warnings.push(`${label}: ${w}x${h} is larger than the ${W}x${H} frame; it will be cropped by the frame edge`);
  const cx = Math.max(0, Math.min(x, W - w));
  const cy = Math.max(0, Math.min(y, H - h));
  if (cx !== x || cy !== y) {
    warnings.push(`${label}: ${w}x${h} at (${x},${y}) extends off the ${W}x${H} frame; position clamped to (${cx},${cy})`);
    [x, y] = [cx, cy];
  }
  return { sw, sh, w, h, x, y, crop, warnings };
}

export const LAYER_MOTIONS = ["slide-left", "slide-right", "slide-up", "slide-down", "scale"] as const;
export interface LayerMotion {
  type: (typeof LAYER_MOTIONS)[number];
  durationSec: number;
}

export interface GraphOptions {
  /** Layers composited bottom → top by zIndex. */
  layers?: GraphLayer[];
  /** Legacy single layer (mapped to `layers[0]`). */
  overlay?: string;
  layerStartSec?: number;
  layerDurationSec?: number;
}

/** Sort layers bottom → top (zIndex, then array order) and validate them. */
export function orderLayers(layers: GraphLayer[]): GraphLayer[] {
  layers.forEach((l, i) => {
    if ((l.startSec ?? 0) < 0) throw new Error(`layer ${i}: startSec must be >= 0`);
    if (l.durationSec !== undefined && !(l.durationSec > 0)) throw new Error(`layer ${i}: durationSec must be > 0`);
    if (l.scaleMode !== undefined && !LAYER_SCALE_MODES.includes(l.scaleMode)) throw new Error(`layer ${i}: unknown scaleMode ${l.scaleMode}`);
    if (l.fit !== undefined && !LAYER_FITS.includes(l.fit)) throw new Error(`layer ${i}: unknown fit ${l.fit}`);
    const maxScale = l.scaleMode === "native" ? 10 : 1;
    if (l.scale !== undefined && !(l.scale > 0 && l.scale <= maxScale)) throw new Error(`layer ${i}: scale must be in (0, ${maxScale}]`);
    for (const k of ["width", "height"] as const)
      if (l[k] !== undefined && !(l[k]! >= 2)) throw new Error(`layer ${i}: ${k} must be >= 2 px`);
    if (l.scale !== undefined && (l.width !== undefined || l.height !== undefined)) throw new Error(`layer ${i}: pass scale or width/height, not both`);
    for (const k of ["fadeInSec", "fadeOutSec"] as const)
      if (l[k] !== undefined && !(l[k]! > 0)) throw new Error(`layer ${i}: ${k} must be > 0`);
    for (const k of ["enter", "exit"] as const) {
      const m = l[k];
      if (!m) continue;
      if (!LAYER_MOTIONS.includes(m.type)) throw new Error(`layer ${i}: unknown ${k} motion ${m.type}`);
      if (!(m.durationSec > 0)) throw new Error(`layer ${i}: ${k}.durationSec must be > 0`);
    }
    if ((l.fadeOutSec || l.exit) && l.durationSec === undefined)
      throw new Error(`layer ${i}: fadeOutSec/exit need durationSec (the layer end must be known)`);
    if (l.durationSec !== undefined) {
      const d = l.durationSec;
      const fades = (l.fadeInSec ?? 0) + (l.fadeOutSec ?? 0);
      if (fades > d + 1e-6) throw new Error(`layer ${i}: fadeInSec + fadeOutSec (${fades}s) do not fit in durationSec (${d}s)`);
      const moves = (l.enter?.durationSec ?? 0) + (l.exit?.durationSec ?? 0);
      if (moves > d + 1e-6) throw new Error(`layer ${i}: enter + exit durations (${moves}s) do not fit in durationSec (${d}s)`);
    }
  });
  return layers.map((l, i) => ({ l, z: l.zIndex ?? i, i })).sort((a, b) => a.z - b.z || a.i - b.i).map((x) => x.l);
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
  const curve = (cv?: AudioCurve) => AFADE_CURVE[cv ?? "linear"];
  /** Clip-level audio fades (audioFade), in clip-local time. */
  const clipFades = (c: Clip) => {
    const f = c.audioFade;
    if (!f) return "";
    const d = clipDuration(c);
    const cv = curve(f.curve);
    return (f.inSec ? `,afade=t=in:d=${num(f.inSec)}:curve=${cv}` : "") + (f.outSec ? `,afade=t=out:st=${num(d - f.outSec)}:d=${num(f.outSec)}:curve=${cv}` : "");
  };

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
      if (s.hasAudio) parts.push(`[${i}:a]asetpts=PTS-STARTPTS,${AFMT}${gain(c)},apad,atrim=0:${num(d)}${clipFades(c)}[a${k}]`);
      else parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(d)},${AFMT}[a${k}]`);
      const a = `[a${k}]`;
      if (c.transition && chain) {
        const td = c.transition.durationSec;
        if (isVideo) {
          parts.push(`${chain.v}${v}xfade=transition=${XFADE[c.transition.type]}:duration=${num(td)}:offset=${num(chain.len - td)}[x${k}]`);
          chain.v = `[x${k}]`;
        }
        parts.push(`${chain.a}${a}acrossfade=d=${num(td)}:c1=${curve(c.transition.curve)}:c2=${curve(c.transition.curve)}[xa${k}]`);
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
      // Crossfade = real overlap: placeClips starts the incoming clip `durationSec` early; it fades in (tri)
      // while the outgoing clip fades out over the same window and both are summed (same curve as acrossfade c1/c2=tri).
      // A literal acrossfade filter is not used here: feeding acrossfade into amix next to a video program stalls the
      // bed in ffmpeg's scheduler (no frames reach the mixer), while fade+adelay+amix is sample-accurate and stable.
      const next = placements[k + 1]?.clip.transition;
      // Same curve on both sides of the summed crossfade (the incoming clip's transition.curve).
      const fin = c.transition ? `,afade=t=in:d=${num(c.transition.durationSec)}:curve=${curve(c.transition.curve)}` : "";
      const fout = next ? `,afade=t=out:st=${num(d - next.durationSec)}:d=${num(next.durationSec)}:curve=${curve(next.curve)}` : "";
      parts.push(`[${i}:a]asetpts=PTS-STARTPTS,${AFMT}${gain(c)},atrim=0:${num(d)}${clipFades(c)}${fin}${fout}${ms > 0 ? `,adelay=${ms}:all=1` : ""}[m${m}_${k}]`);
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
  const warnings: string[] = [];
  const layers = [...(opts.layers ?? [])];
  if (opts.overlay) layers.unshift({ src: opts.overlay, startSec: opts.layerStartSec, durationSec: opts.layerDurationSec });
  if (layers.length && !programVideo) throw new Error("layers need a video program");
  if (programVideo && layers.length) {
    const { width: w, height: h } = target as Required<GraphTarget>;
    orderLayers(layers).forEach((l, n) => {
      // libvpx-vp9 decodes the alpha plane of VP9 webm (the native decoder drops it).
      if (/\.webm$/i.test(l.src)) inputArgs.push("-c:v", "libvpx-vp9");
      inputArgs.push("-i", l.src);
      const o = idx++;
      const st = l.startSec ?? 0;
      const shift = st > 0 ? `+${num(st)}/TB` : "";
      const enable = l.durationSec ? `:enable='between(t,${num(st)},${num(st + l.durationSec)})'` : "";
      const lay = layoutLayer(l, w, h, `layer ${n}`);
      warnings.push(...lay.warnings);
      const { w: lw, h: lh, x: X, y: Y } = lay;
      const end = l.durationSec !== undefined ? st + l.durationSec : undefined;
      // Motion progress (0→1) in program time t: p = entry progress, q = exit progress.
      const p = l.enter ? `clip((t-${num(st)})/${num(l.enter.durationSec)},0,1)` : "1";
      const q = l.exit && end !== undefined ? `clip((t-${num(end - l.exit.durationSec)})/${num(l.exit.durationSec)},0,1)` : "0";
      let fx = `${X}`;
      let fy = `${Y}`;
      const off = (m: LayerMotion | undefined, prog: string) => {
        // Off-frame start/end position for a slide; "slide-left" moves leftwards (enters from the right, exits to the left).
        if (!m || m.type === "scale") return;
        const into = prog === p;
        const ox = m.type === "slide-left" ? (into ? "W" : "-w") : m.type === "slide-right" ? (into ? "-w" : "W") : undefined;
        const oy = m.type === "slide-up" ? (into ? "H" : "-h") : m.type === "slide-down" ? (into ? "-h" : "H") : undefined;
        const k = into ? `(1-${prog})` : prog;
        if (ox) fx += `+(${ox}-${X})*${k}`;
        if (oy) fy += `+(${oy}-${Y})*${k}`;
      };
      off(l.enter, p);
      off(l.exit, q);
      const scaling = l.enter?.type === "scale" || l.exit?.type === "scale";
      let geom = `scale=${lay.sw}:${lay.sh}` + (lay.crop ? `,crop=${lw}:${lh}` : "");
      if (scaling) {
        const f = `max(0.01,${l.enter?.type === "scale" ? p : "1"}*(1-${l.exit?.type === "scale" ? q : "0"}))`;
        geom = `scale=w='max(2,trunc(${lw}*${f}/2)*2)':h='max(2,trunc(${lh}*${f}/2)*2)':eval=frame`;
        // Keep the layer centred on its final box while it grows/shrinks.
        fx += `+(${lw}-w)/2`;
        fy += `+(${lh}-h)/2`;
      }
      let alpha = "";
      if (l.fadeInSec) alpha += `,fade=t=in:st=${num(st)}:d=${num(l.fadeInSec)}:alpha=1`;
      if (l.fadeOutSec && end !== undefined) alpha += `,fade=t=out:st=${num(end - l.fadeOutSec)}:d=${num(l.fadeOutSec)}:alpha=1`;
      parts.push(`[${o}:v]setpts=PTS-STARTPTS${shift},${geom},format=yuva420p${alpha}[ly${n}]`);
      const moving = l.enter || l.exit;
      const pos = moving ? `x='${fx}':y='${fy}':eval=frame` : `${X}:${Y}`;
      parts.push(`${videoOut}[ly${n}]overlay=${pos}:eof_action=pass:format=auto${enable}[lo${n}]`);
      videoOut = `[lo${n}]`;
    });
    parts.push(`${videoOut}format=yuv420p[vout]`);
    videoOut = "[vout]";
  }

  return {
    inputArgs,
    filterComplex: parts.join(";"),
    maps: [...(videoOut ? [videoOut] : []), audioOut],
    durationSec: duration,
    warnings,
  };
}
