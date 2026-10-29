import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { compose } from "./compose.js";
import { isStillSrc, programBreakdown, type Timeline } from "./timeline.js";
import { buildTimelineGraph, orderLayers, type GraphLayer, type SourceInfo } from "./timelineRender.js";
import { inspect, type OnProgress } from "./edit.js";
import { ffmpeg, ffmpegWithProgress, probe, type ProbeResult } from "./ffmpeg.js";
import { buildZip } from "./zip.js";
import { renderCaptions, type CaptionEngine } from "./caption-render.js";
import { loadCues, type CueSource } from "./caption-source.js";
import { loadProducer } from "./hyperframes.js";
import { formatSrt, type SubtitleCue } from "./subtitles.js";

export interface VideoPreset {
  kind: "video";
  width: number;
  height: number;
  fps: number;
  videoBitrate: string;
  audioBitrate: string;
  ext: ".mp4";
}
export interface AudioPreset {
  kind: "audio";
  audioBitrate: string;
  sampleRate: number;
  ext: ".m4a";
}
export type Preset = VideoPreset | AudioPreset;

/** Encode presets. All video presets are H.264 (yuv420p, +faststart) + AAC; fit-and-pad to the target frame. */
export const PRESETS = {
  "web-1080p": { kind: "video", width: 1920, height: 1080, fps: 30, videoBitrate: "8M", audioBitrate: "192k", ext: ".mp4" },
  "vertical-9x16": { kind: "video", width: 1080, height: 1920, fps: 30, videoBitrate: "8M", audioBitrate: "192k", ext: ".mp4" },
  square: { kind: "video", width: 1080, height: 1080, fps: 30, videoBitrate: "6M", audioBitrate: "192k", ext: ".mp4" },
  "audio-only": { kind: "audio", audioBitrate: "192k", sampleRate: 48000, ext: ".m4a" },
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]];

export interface RenderRequest {
  /** Single source file (mutually exclusive with `timeline`). */
  input?: string;
  /** Timeline to assemble and encode (mutually exclusive with `input`). */
  timeline?: Timeline;
  preset: PresetName;
  output: string;
  /** Alpha video (e.g. a HyperFrames webm/mov) composited over the whole program. Video presets only. */
  overlay?: string;
  /** HyperFrames composition (HTML) rendered with alpha and composited over the program. Needs the optional peer. */
  hyperframes?: string;
  /** Program time (s) where the overlay/HyperFrames layer starts. Default 0. */
  layerStartSec?: number;
  /** How long the layer is shown (s). Default: until the layer ends. */
  layerDurationSec?: number;
  /** Several layers composited bottom → top (zIndex, then array order). Each has exactly one of overlay/hyperframes. */
  layers?: RenderLayer[];
  /** Captions burned in after composition (program time). Video presets only. */
  captions?: RenderCaptions;
  /** Two-pass EBU R128 loudness normalization of the final mix (after captions). Off when omitted. */
  loudness?: LoudnessTarget;
  overwrite?: boolean;
  onProgress?: OnProgress;
}

export interface LoudnessTarget {
  /** Integrated loudness target, LUFS (default -16). */
  targetLufs?: number;
  /** True-peak ceiling, dBTP (default -1). */
  truePeakDb?: number;
  /** Loudness range target, LU (default 11). */
  lra?: number;
}

export interface LoudnessNormalization {
  target: Required<LoudnessTarget>;
  /** Measured on the mix before normalization (pass 1). */
  before: Loudness;
  /** Measured on the delivered file. */
  after: Loudness;
  /** `linear` (pure gain via loudnorm) or `limited` (gain + 4x-oversampled true-peak limiter, because pure gain would break the ceiling). */
  mode: "linear" | "limited";
}

/** Sidecar written next to a loudness-normalized render; `export.package` copies it into spec.json. */
export const sidecarLoudness = (output: string): string => output.slice(0, output.length - extname(output).length) + ".loudness.json";

export interface RenderCaptions extends CueSource {
  /** `auto` (default): HyperFrames when the optional peer is installed, else the ffmpeg/libass fallback. */
  engine?: CaptionEngine | "auto";
  /** Where to write the SRT of the cues actually burned in. Default: the output path with `.srt`. */
  srtOutput?: string;
}

export interface RenderCaptionsInfo {
  engine: CaptionEngine;
  cues: number;
  style: string;
  /** SRT of the burned-in cues; `export.package` picks it up as captions.srt. */
  srt: string;
}

/** Default sidecar SRT path for a rendered file: same name, `.srt`. */
export const sidecarSrt = (output: string): string => output.slice(0, output.length - extname(output).length) + ".srt";

export interface RenderLayer extends Omit<GraphLayer, "src"> {
  /** Alpha video file. */
  overlay?: string;
  /** HyperFrames composition HTML (rendered with alpha). */
  hyperframes?: string;
}

export interface RenderResult {
  output: string;
  preset: PresetName;
  durationSec: number;
  overlay?: string;
  /** Number of layers composited. */
  layers?: number;
  /** Measured from the output file. */
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  bytes?: number;
  /** Present when captions were burned in. */
  captions?: RenderCaptionsInfo;
  /** Present when `loudness` was requested. */
  loudness?: LoudnessNormalization;
  /** Timeline length with transition overlaps removed and gaps included (what `-t` was set to). */
  program?: { durationSec: number; clipsSec: number; overlapSec: number; gapSec: number };
  /** Non-fatal notes, e.g. a layer clamped into the frame. Empty when nothing was adjusted. */
  warnings: string[];
}

function guardOutput(output: string, overwrite?: boolean): void {
  if (!overwrite && existsSync(output)) throw new Error(`output exists: ${output} (pass overwrite: true)`);
}

function videoEncodeArgs(p: VideoPreset): string[] {
  return ["-c:v", "libx264", "-preset", "medium", "-b:v", p.videoBitrate, "-pix_fmt", "yuv420p"];
}
const audioEncodeArgs = (bitrate: string) => ["-c:a", "aac", "-b:a", bitrate, "-ar", "48000", "-ac", "2"];

/** Encode `input` or assemble a `timeline` with one of the fixed presets, optionally with an alpha overlay layer. */
export async function render(req: RenderRequest): Promise<RenderResult> {
  const preset: Preset = PRESETS[req.preset];
  if (!preset) throw new Error(`unknown preset: ${req.preset}`);
  if (Boolean(req.input) === Boolean(req.timeline)) throw new Error("pass exactly one of input or timeline");
  if (req.overlay && req.hyperframes) throw new Error("pass at most one of overlay or hyperframes");
  // Legacy single-layer params map to a first layer.
  const reqLayers: RenderLayer[] = [
    ...(req.overlay || req.hyperframes
      ? [{ overlay: req.overlay, hyperframes: req.hyperframes, startSec: req.layerStartSec, durationSec: req.layerDurationSec }]
      : []),
    ...(req.layers ?? []),
  ];
  if (reqLayers.length && preset.kind !== "video") throw new Error("overlay/hyperframes/layers need a video preset");
  reqLayers.forEach((l, i) => {
    if (Boolean(l.overlay) === Boolean(l.hyperframes)) throw new Error(`layer ${i}: pass exactly one of overlay or hyperframes`);
    if (l.overlay && !existsSync(l.overlay)) throw new Error(`overlay not found: ${l.overlay}`);
    if (l.hyperframes && !existsSync(l.hyperframes)) throw new Error(`hyperframes composition not found: ${l.hyperframes}`);
  });
  guardOutput(req.output, req.overwrite);
  const loud = req.loudness && resolveLoudness(req.loudness);
  if (loud) guardOutput(sidecarLoudness(req.output), req.overwrite);
  let cues: SubtitleCue[] | undefined;
  if (req.captions) {
    if (preset.kind !== "video") throw new Error("captions need a video preset");
    cues = await loadCues(req.captions);
    const srtPath = req.captions.srtOutput ?? sidecarSrt(req.output);
    if (srtPath === req.output) throw new Error("captions.srtOutput must differ from output");
    guardOutput(srtPath, req.overwrite);
  }
  // Validate layer timing/animation up front (before any HyperFrames compose).
  orderLayers(reqLayers.map((l) => ({ ...l, src: "" })));

  // Single input → same as a one-clip timeline over the whole file.
  let timeline = req.timeline;
  if (req.input) {
    if (!existsSync(req.input)) throw new Error(`input not found: ${req.input}`);
    const info = await inspect(req.input);
    if (preset.kind === "audio" && !info.hasAudio) throw new Error("audio-only preset needs an input with an audio stream");
    if (preset.kind === "video" && !info.hasVideo) throw new Error(`preset ${req.preset} needs an input with a video stream`);
    if (!(info.durationSec > 0)) throw new Error(`cannot read duration of ${req.input}`);
    timeline = {
      width: info.width ?? 0, height: info.height ?? 0, fps: info.fps ?? 30,
      tracks: [{ id: "main", kind: info.hasVideo ? "video" : "audio", clips: [{ id: "main", src: req.input, in: 0, out: info.durationSec }] }],
    };
    if (!(timeline.width > 0)) Object.assign(timeline, { width: 1, height: 1 });
  }
  const tl = timeline!;
  const sources: SourceInfo = {};
  for (const t of tl.tracks) {
    if (t.kind === "caption") continue;
    for (const c of t.clips) {
      if (sources[c.src]) continue;
      if (!existsSync(c.src)) throw new Error(`clip ${c.id}: source not found: ${c.src}`);
      if (isStillSrc(c.src)) {
        if (t.kind === "audio") throw new Error(`clip ${c.id}: still image ${c.src} cannot be on an audio track`);
        sources[c.src] = { hasVideo: true, hasAudio: false };
        continue;
      }
      const i = await inspect(c.src);
      sources[c.src] = { hasVideo: i.hasVideo, hasAudio: i.hasAudio };
    }
  }

  let tmp: string | undefined;
  let warnings: string[] | undefined;
  let captionsInfo: RenderCaptionsInfo | undefined;
  let loudInfo: LoudnessNormalization | undefined;
  let programInfo: RenderResult["program"];
  try {
    const layers: GraphLayer[] = [];
    for (const [i, l] of reqLayers.entries()) {
      let src = l.overlay!;
      if (l.hyperframes) {
        tmp ??= mkdtempSync(join(tmpdir(), "vem-hf-"));
        src = join(tmp, `layer${i}.webm`);
        await compose({ composition: l.hyperframes, output: src, format: "webm", fps: (preset as VideoPreset).fps });
      }
      const sv = (await probe(src)).streams.find((s) => s.type === "video");
      layers.push({ src, startSec: l.startSec, durationSec: l.durationSec, zIndex: l.zIndex ?? i, x: l.x, y: l.y, scale: l.scale, scaleMode: l.scaleMode, width: l.width, height: l.height, fit: l.fit, srcWidth: sv?.width, srcHeight: sv?.height, fadeInSec: l.fadeInSec, fadeOutSec: l.fadeOutSec, enter: l.enter, exit: l.exit });
    }
    const target = preset.kind === "video" ? { kind: "video" as const, width: preset.width, height: preset.height, fps: preset.fps } : { kind: "audio" as const };
    const g = buildTimelineGraph(tl, target, sources, { layers });
    warnings = g.warnings;
    const progTrack = tl.tracks.find((t) => t.kind === "video") ?? tl.tracks.find((t) => t.kind === "audio");
    if (progTrack) programInfo = { ...programBreakdown(progTrack), durationSec: g.durationSec };
    // Last file of the encode chain before loudness normalization.
    const finalOut = loud ? join((tmp ??= mkdtempSync(join(tmpdir(), "vem-hf-"))), "mix" + preset.ext) : req.output;
    const args = ["-y", ...g.inputArgs, "-filter_complex", g.filterComplex];
    for (const m of g.maps) args.push("-map", m);
    if (preset.kind === "video") args.push(...videoEncodeArgs(preset), ...audioEncodeArgs(preset.audioBitrate));
    else args.push(...audioEncodeArgs(preset.audioBitrate));
    // With captions, the composed program goes to a temp file and the burn-in pass writes the output.
    let program = finalOut;
    if (cues) {
      tmp ??= mkdtempSync(join(tmpdir(), "vem-hf-"));
      program = join(tmp, "program.mp4");
    }
    args.push("-t", String(g.durationSec), "-movflags", "+faststart", program);
    const total = g.durationSec;
    const r = await ffmpegWithProgress(args, req.onProgress && ((u) => req.onProgress?.(u, total)), 600_000);
    if (r.code !== 0) throw new Error(`ffmpeg render failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    if (cues && req.captions && preset.kind === "video") {
      const burn = (engine: CaptionEngine) =>
        renderCaptions({
          input: program, output: finalOut, engine, style: req.captions!.style, cues,
          width: preset.width, height: preset.height, fps: preset.fps, overwrite: true,
          videoEncodeArgs: [...videoEncodeArgs(preset), "-movflags", "+faststart"],
        });
      let engine: CaptionEngine;
      if (req.captions.engine === "hyperframes" || req.captions.engine === "ffmpeg") {
        engine = req.captions.engine;
        await burn(engine);
      } else if ((await loadProducer()) == null) {
        engine = "ffmpeg";
        warnings.push("captions: HyperFrames engine unavailable, burned in with the ffmpeg (libass) fallback");
        await burn(engine);
      } else {
        // The peer can be installed without a launchable browser: fall back instead of failing.
        try {
          engine = "hyperframes";
          await burn(engine);
        } catch (err) {
          engine = "ffmpeg";
          const reason = (err as Error).message.split("\n")[0]!.slice(0, 200);
          warnings.push(`captions: HyperFrames render failed (${reason}), burned in with the ffmpeg (libass) fallback`);
          await burn(engine);
        }
      }
      const srt = req.captions.srtOutput ?? sidecarSrt(req.output);
      writeFileSync(srt, formatSrt(cues), "utf8");
      captionsInfo = { engine, cues: cues.length, style: req.captions.style ?? "plain", srt };
    }
    if (loud) {
      loudInfo = await normalizeLoudness(finalOut, req.output, loud, preset.audioBitrate);
      const sha = sha256(readFileSync(req.output));
      writeFileSync(sidecarLoudness(req.output), JSON.stringify({ schema: "video-edit-mcp/loudness@1", sha256: sha, ...loudInfo }, null, 2) + "\n");
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  const out = await probe(req.output);
  const ov = out.streams.find((s) => s.type === "video");
  const oa = out.streams.find((s) => s.type === "audio");
  return {
    output: req.output, preset: req.preset, durationSec: out.durationSec ?? 0,
    ...(req.overlay || req.hyperframes ? { overlay: req.hyperframes ? "hyperframes" : req.overlay } : {}),
    ...(reqLayers.length ? { layers: reqLayers.length } : {}),
    width: ov?.width, height: ov?.height, fps: ov?.fps, videoCodec: ov?.codec, audioCodec: oa?.codec, bytes: out.sizeBytes,
    ...(captionsInfo ? { captions: captionsInfo } : {}),
    ...(loudInfo ? { loudness: loudInfo } : {}),
    ...(programInfo ? { program: programInfo } : {}),
    warnings: warnings ?? [],
  };
}

export interface Loudness {
  integratedLufs: number;
  truePeakDbtp: number;
  lraLu: number;
  thresholdLufs: number;
}

/** Measure loudness with ffmpeg's loudnorm analysis pass (EBU R128). `undefined` when there is no audio. */
export async function measureLoudness(path: string): Promise<Loudness | undefined> {
  const info = await inspect(path);
  if (!info.hasAudio) return undefined;
  const r = await ffmpeg(["-nostats", "-i", path, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"], 600_000);
  if (r.code !== 0) throw new Error(`loudness measurement failed: ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  const start = r.stderr.lastIndexOf("{");
  const end = r.stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm produced no JSON report");
  const j = JSON.parse(r.stderr.slice(start, end + 1)) as Record<string, string>;
  const n = (k: string) => {
    const v = Number(j[k]);
    if (!Number.isFinite(v)) throw new Error(`loudnorm field ${k} is not numeric: ${j[k]}`);
    return v;
  };
  return { integratedLufs: n("input_i"), truePeakDbtp: n("input_tp"), lraLu: n("input_lra"), thresholdLufs: n("input_thresh") };
}

export function resolveLoudness(t: LoudnessTarget): Required<LoudnessTarget> {
  const r = { targetLufs: t.targetLufs ?? -16, truePeakDb: t.truePeakDb ?? -1, lra: t.lra ?? 11 };
  if (!(r.targetLufs >= -70 && r.targetLufs <= -5)) throw new Error("loudness.targetLufs must be in [-70, -5]");
  if (!(r.truePeakDb >= -9 && r.truePeakDb <= 0)) throw new Error("loudness.truePeakDb must be in [-9, 0]");
  if (!(r.lra >= 1 && r.lra <= 50)) throw new Error("loudness.lra must be in [1, 50]");
  return r;
}

const lastJson = (stderr: string): Record<string, string> => {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm produced no JSON report");
  return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
};

/**
 * Two-pass loudnorm: pass 1 measures the mix, pass 2 applies the measured values (linear gain when the
 * true-peak ceiling allows it). Video is stream-copied; audio is re-encoded AAC 48 kHz stereo.
 */
export async function normalizeLoudness(input: string, output: string, target: Required<LoudnessTarget>, audioBitrate: string): Promise<LoudnessNormalization> {
  const info = await inspect(input);
  if (!info.hasAudio) throw new Error("loudness normalization needs an audio stream");
  const { targetLufs: I, truePeakDb: TP, lra: LRA } = target;
  const p1 = await ffmpeg(["-nostats", "-i", input, "-vn", "-af", `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, "-f", "null", "-"], 600_000);
  if (p1.code !== 0) throw new Error(`loudnorm pass 1 failed: ${p1.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  const m = lastJson(p1.stderr);
  const before: Loudness = { integratedLufs: Number(m.input_i), truePeakDbtp: Number(m.input_tp), lraLu: Number(m.input_lra), thresholdLufs: Number(m.input_thresh) };
  if (!Number.isFinite(before.integratedLufs) || before.integratedLufs < -70) throw new Error("loudness normalization: the mix is silent (nothing to normalize)");
  const encode = async (af: string) => {
    const args = ["-y", "-nostats", "-i", input, "-map", "0:v?", "-map", "0:a:0", "-c:v", "copy", "-af", af, ...audioEncodeArgs(audioBitrate), "-movflags", "+faststart", output];
    const p = await ffmpeg(args, 600_000);
    if (p.code !== 0) throw new Error(`loudness pass 2 failed: ${p.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    return p;
  };
  const gain = I - before.integratedLufs;
  let mode: LoudnessNormalization["mode"] = "linear";
  let after: Loudness | undefined;
  if (before.truePeakDbtp + gain <= TP - 0.1) {
    // Pure gain fits under the ceiling: loudnorm linear is exact.
    await encode(`loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,aresample=48000`);
    after = await measureLoudness(output);
  } else {
    // loudnorm's dynamic mode undershoots badly on short mixes; instead apply gain + an oversampled
    // limiter and correct the gain from the measured result (limiting eats loudness) up to 3 times.
    mode = "limited";
    const limit = Math.pow(10, (TP - 0.5) / 20).toFixed(4);
    let g = gain;
    for (let i = 0; i < 3; i++) {
      await encode(`volume=${g.toFixed(2)}dB,aresample=192000,alimiter=limit=${limit}:attack=1:release=50:level=0,aresample=48000`);
      after = await measureLoudness(output);
      const err = I - (after?.integratedLufs ?? I);
      if (Math.abs(err) <= 0.5) break;
      g += err;
    }
  }
  return { target, before, after: after!, mode };
}

export interface DeliverySpec {
  schema: "video-edit-mcp/spec@1";
  createdAt: string;
  preset?: string;
  file: string;
  container?: string;
  durationSec?: number;
  sizeBytes?: number;
  video?: { codec?: string; width?: number; height?: number; fps?: number };
  audio?: { codec?: string; sampleRate?: number; channels?: number };
  loudness?: Loudness;
  /** Normalization applied by render/export (target, measured before and after). */
  loudnessNormalization?: LoudnessNormalization;
  engines: { ffmpeg?: string };
  checksums: Record<string, string>;
}

export interface PackageRequest {
  video: string;
  output: string;
  subtitles?: string;
  preset?: string;
  /** When `subtitles` is omitted, include the render's sidecar `<video>.srt` if it exists (default true). */
  sidecarCaptions?: boolean;
  /** Normalize the media's loudness (two-pass) before packaging. Off when omitted. */
  loudness?: LoudnessTarget;
  overwrite?: boolean;
}

export interface PackageResult {
  output: string;
  entries: string[];
  spec: DeliverySpec;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function ffmpegVersion(): Promise<string | undefined> {
  try {
    const r = await ffmpeg(["-version"], 10_000);
    return r.stdout.split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

function specFrom(probed: ProbeResult, file: string): Pick<DeliverySpec, "file" | "container" | "durationSec" | "sizeBytes" | "video" | "audio"> {
  const v = probed.streams.find((s) => s.type === "video");
  const a = probed.streams.find((s) => s.type === "audio");
  return {
    file,
    container: probed.format,
    durationSec: probed.durationSec,
    sizeBytes: probed.sizeBytes,
    video: v && { codec: v.codec, width: v.width, height: v.height, fps: v.fps },
    audio: a && { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels },
  };
}

/**
 * Build a delivery ZIP: the media file, optional `captions.srt`, `spec.json` (all values measured
 * with ffprobe/loudnorm on the actual file) and `checksums.sha256` covering every other entry.
 */
export async function exportPackage(req: PackageRequest): Promise<PackageResult> {
  if (!existsSync(req.video)) throw new Error(`video not found: ${req.video}`);
  if (!req.subtitles && req.sidecarCaptions !== false && existsSync(sidecarSrt(req.video)) && sidecarSrt(req.video) !== req.video) {
    req = { ...req, subtitles: sidecarSrt(req.video) };
  }
  if (req.subtitles && !existsSync(req.subtitles)) throw new Error(`subtitles not found: ${req.subtitles}`);
  if (req.subtitles && extname(req.subtitles).toLowerCase() !== ".srt") throw new Error("subtitles must be an .srt file");
  guardOutput(req.output, req.overwrite);

  let tmp: string | undefined;
  try {
    return await buildPackage(req, () => (tmp = mkdtempSync(join(tmpdir(), "vem-pkg-"))));
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

async function buildPackage(req: PackageRequest, makeTmp: () => string): Promise<PackageResult> {
  let mediaPath = req.video;
  let norm: LoudnessNormalization | undefined;
  if (req.loudness) {
    const target = resolveLoudness(req.loudness);
    mediaPath = join(makeTmp(), "normalized" + (extname(req.video) || ".mp4"));
    norm = await normalizeLoudness(req.video, mediaPath, target, "192k");
  }
  const probed = await probe(mediaPath);
  const mediaName = (probed.streams.some((s) => s.type === "video") ? "video" : "audio") + (extname(req.video) || ".mp4");
  const media = readFileSync(mediaPath);
  if (!norm && existsSync(sidecarLoudness(req.video))) {
    // Loudness sidecar written by render: trusted only while it describes these exact bytes.
    try {
      const side = JSON.parse(readFileSync(sidecarLoudness(req.video), "utf8")) as LoudnessNormalization & { sha256?: string };
      if (side.sha256 === sha256(media)) norm = { target: side.target, before: side.before, after: side.after, mode: side.mode };
    } catch {
      // unreadable sidecar: ignore
    }
  }
  const files: { name: string; data: Buffer }[] = [{ name: mediaName, data: media }];
  if (req.subtitles) files.push({ name: "captions.srt", data: readFileSync(req.subtitles) });

  const checksums: Record<string, string> = {};
  for (const f of files) checksums[f.name] = sha256(f.data);

  const spec: DeliverySpec = {
    schema: "video-edit-mcp/spec@1",
    createdAt: new Date().toISOString(),
    preset: req.preset,
    ...specFrom(probed, mediaName),
    loudness: await measureLoudness(mediaPath),
    ...(norm ? { loudnessNormalization: norm } : {}),
    engines: { ffmpeg: await ffmpegVersion() },
    checksums,
  };
  const specBuf = Buffer.from(JSON.stringify(spec, null, 2) + "\n");
  files.push({ name: "spec.json", data: specBuf });
  const sums = files.map((f) => `${sha256(f.data)}  ${f.name}`).join("\n") + "\n";
  files.push({ name: "checksums.sha256", data: Buffer.from(sums) });

  writeFileSync(req.output, buildZip(files));
  return { output: req.output, entries: files.map((f) => f.name), spec };
}

