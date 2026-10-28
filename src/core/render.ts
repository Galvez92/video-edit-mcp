import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
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
  input: string;
  preset: PresetName;
  output: string;
  overwrite?: boolean;
  onProgress?: OnProgress;
}

export interface RenderResult {
  output: string;
  preset: PresetName;
  durationSec: number;
}

function guardOutput(output: string, overwrite?: boolean): void {
  if (!overwrite && existsSync(output)) throw new Error(`output exists: ${output} (pass overwrite: true)`);
}

/** Encode `input` with one of the fixed presets. */
export async function render(req: RenderRequest): Promise<RenderResult> {
  const preset: Preset = PRESETS[req.preset];
  if (!preset) throw new Error(`unknown preset: ${req.preset}`);
  if (!existsSync(req.input)) throw new Error(`input not found: ${req.input}`);
  guardOutput(req.output, req.overwrite);
  const info = await inspect(req.input);
  const args = ["-y", "-i", req.input];
  if (preset.kind === "audio") {
    if (!info.hasAudio) throw new Error("audio-only preset needs an input with an audio stream");
    args.push("-vn", "-c:a", "aac", "-b:a", preset.audioBitrate, "-ar", String(preset.sampleRate), "-ac", "2");
  } else {
    if (!info.hasVideo) throw new Error(`preset ${req.preset} needs an input with a video stream`);
    const { width: w, height: h, fps } = preset;
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
    args.push("-vf", vf, "-c:v", "libx264", "-preset", "medium", "-b:v", preset.videoBitrate, "-pix_fmt", "yuv420p");
    if (info.hasAudio) args.push("-c:a", "aac", "-b:a", preset.audioBitrate, "-ar", "48000", "-ac", "2");
    else args.push("-an");
  }
  args.push("-movflags", "+faststart", req.output);
  const total = info.durationSec;
  const r = await ffmpegWithProgress(args, req.onProgress && ((u) => req.onProgress?.(u, total)), 600_000);
  if (r.code !== 0) throw new Error(`ffmpeg render failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  const out = await probe(req.output);
  return { output: req.output, preset: req.preset, durationSec: out.durationSec ?? 0 };
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

