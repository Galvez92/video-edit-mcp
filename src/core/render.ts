import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { compose } from "./compose.js";
import type { Timeline } from "./timeline.js";
import { buildTimelineGraph, orderLayers, type GraphLayer, type SourceInfo } from "./timelineRender.js";
import { inspect, type OnProgress } from "./edit.js";
import { ffmpeg, ffmpegWithProgress, probe, type ProbeResult } from "./ffmpeg.js";
import { buildZip } from "./zip.js";

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
  overwrite?: boolean;
  onProgress?: OnProgress;
}

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
      const i = await inspect(c.src);
      sources[c.src] = { hasVideo: i.hasVideo, hasAudio: i.hasAudio };
    }
  }

  let tmp: string | undefined;
  let warnings: string[] | undefined;
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
    const args = ["-y", ...g.inputArgs, "-filter_complex", g.filterComplex];
    for (const m of g.maps) args.push("-map", m);
    if (preset.kind === "video") args.push(...videoEncodeArgs(preset), ...audioEncodeArgs(preset.audioBitrate));
    else args.push(...audioEncodeArgs(preset.audioBitrate));
    args.push("-t", String(g.durationSec), "-movflags", "+faststart", req.output);
    const total = g.durationSec;
    const r = await ffmpegWithProgress(args, req.onProgress && ((u) => req.onProgress?.(u, total)), 600_000);
    if (r.code !== 0) throw new Error(`ffmpeg render failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
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
  engines: { ffmpeg?: string };
  checksums: Record<string, string>;
}

export interface PackageRequest {
  video: string;
  output: string;
  subtitles?: string;
  preset?: string;
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
  if (req.subtitles && !existsSync(req.subtitles)) throw new Error(`subtitles not found: ${req.subtitles}`);
  if (req.subtitles && extname(req.subtitles).toLowerCase() !== ".srt") throw new Error("subtitles must be an .srt file");
  guardOutput(req.output, req.overwrite);

  const probed = await probe(req.video);
  const mediaName = (probed.streams.some((s) => s.type === "video") ? "video" : "audio") + (extname(req.video) || ".mp4");
  const media = readFileSync(req.video);
  const files: { name: string; data: Buffer }[] = [{ name: mediaName, data: media }];
  if (req.subtitles) files.push({ name: "captions.srt", data: readFileSync(req.subtitles) });

  const checksums: Record<string, string> = {};
  for (const f of files) checksums[f.name] = sha256(f.data);

  const spec: DeliverySpec = {
    schema: "video-edit-mcp/spec@1",
    createdAt: new Date().toISOString(),
    preset: req.preset,
    ...specFrom(probed, mediaName),
    loudness: await measureLoudness(req.video),
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

