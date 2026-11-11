/**
 * Editing primitives behind the `trim`, `cut` and `concat` tools.
 * Times are in seconds; ranges are half-open ([start, end)). An existing output file
 * is never replaced unless `overwrite: true` is passed.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ffmpegWithProgress, ffprobe, probe, type ProgressUpdate } from "./ffmpeg.js";

export type OnProgress = (update: ProgressUpdate, totalSec: number) => void;

const H264_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"];
const AAC_ARGS = ["-c:a", "aac", "-b:a", "128k"];

export interface MediaInfo {
  path: string;
  /** 0 when the container does not report a duration. */
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
}

/** Probe a file into the subset of stream info the edit primitives need. */
export async function inspect(path: string): Promise<MediaInfo> {
  const info = await probe(path);
  const video = info.streams.find((s) => s.type === "video");
  const audio = info.streams.find((s) => s.type === "audio");
  return {
    path,
    durationSec: info.durationSec ?? 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
    fps: video?.fps,
  };
}

function outputArgs(output: string, overwrite: boolean): string[] {
  if (!overwrite && existsSync(output)) {
    throw new Error(`output already exists: ${output} (pass overwrite:true to replace it)`);
  }
  return [overwrite ? "-y" : "-n"];
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

async function runEdit(what: string, args: string[], totalSec: number, onProgress?: OnProgress): Promise<void> {
  const result = await ffmpegWithProgress(args, onProgress ? (u) => onProgress(u, totalSec) : undefined);
  if (result.code !== 0) throw new Error(`${what} failed: ${lastLine(result.stderr)}`);
}

/** Shared range validation; a duration of 0 means "unknown", so only sanity is checked. */
function checkRange(label: string, start: number, end: number, durationSec: number): void {
  if (!Number.isFinite(start) || start < 0) throw new Error(`${label}: start must be a number >= 0`);
  if (!Number.isFinite(end) || end <= start) throw new Error(`${label}: end must be greater than start`);
  if (durationSec > 0) {
    if (start >= durationSec) throw new Error(`${label}: start (${start}s) is past the end of the input (${durationSec.toFixed(2)}s)`);
    if (end > durationSec + 0.05) throw new Error(`${label}: end (${end}s) exceeds the input duration (${durationSec.toFixed(2)}s)`);
  }
}

/** True when the video stream has a keyframe at `start`, so a stream copy cuts cleanly. */
async function keyframeSafe(info: MediaInfo, start: number): Promise<boolean> {
  if (!info.hasVideo) return true;
  if (start <= 0.001) return true;
  const tolerance = Math.max(0.02, 0.5 / (info.fps ?? 25));
  const from = Math.max(0, start - tolerance - 1);
  const span = start + tolerance + 1 - from;
  const result = await ffprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-read_intervals", `${from}%${span}`,
    "-show_entries", "packet=pts_time,flags",
    "-of", "json",
    info.path,
  ]);
  if (result.code !== 0) return false;
  try {
    const packets = (JSON.parse(result.stdout).packets ?? []) as { pts_time?: string; flags?: string }[];
    return packets.some((p) => (p.flags ?? "").includes("K") && Math.abs(Number(p.pts_time) - start) <= tolerance);
  } catch {
    return false;
  }
}

export interface TrimRequest {
  input: string;
  start: number;
  end: number;
  output: string;
  /** Force re-encoding (true) or a stream copy (false); auto-detected when omitted. */
  reencode?: boolean;
  overwrite?: boolean;
  onProgress?: OnProgress;
}

export interface TrimResult {
  output: string;
  start: number;
  end: number;
  durationSec: number;
  mode: "copy" | "reencode";
}

/** Keep a single range of `input`. Stream copy when keyframe-safe, re-encode otherwise. */
export async function trim(req: TrimRequest): Promise<TrimResult> {
  checkRange("range", req.start, req.end, 0);
  const info = await inspect(req.input);
  checkRange("range", req.start, req.end, info.durationSec);
  const flags = outputArgs(req.output, req.overwrite ?? false);
  const mode: TrimResult["mode"] =
    req.reencode === true
      ? "reencode"
      : req.reencode === false
        ? "copy"
        : (await keyframeSafe(info, req.start))
          ? "copy"
          : "reencode";
  const span = req.end - req.start;
  const codecs =
    mode === "copy"
      ? ["-c", "copy"]
      : [...(info.hasVideo ? H264_ARGS : ["-vn"]), ...(info.hasAudio ? AAC_ARGS : ["-an"])];
  await runEdit(
    "trim",
    ["-ss", String(req.start), "-i", req.input, "-t", String(span), ...codecs, ...flags, req.output],
    span,
    req.onProgress,
  );
  const out = await inspect(req.output);
  return { output: req.output, start: req.start, end: req.end, durationSec: out.durationSec || span, mode };
}

export interface CutSegment {
  start: number;
  end: number;
}

export interface CutRequest {
  input: string;
  segments: CutSegment[];
  output: string;
  overwrite?: boolean;
  onProgress?: OnProgress;
}

export interface CutResult {
  output: string;
  durationSec: number;
  segments: number;
}

/** Keep the listed ranges of one input and join them in the given order (always re-encoded). */
export async function cut(req: CutRequest): Promise<CutResult> {
  if (req.segments.length === 0) throw new Error("segments must contain at least one range");
  req.segments.forEach((s, i) => checkRange(`segment ${i}`, s.start, s.end, 0));
  const info = await inspect(req.input);
  req.segments.forEach((s, i) => checkRange(`segment ${i}`, s.start, s.end, info.durationSec));
  const flags = outputArgs(req.output, req.overwrite ?? false);

  const graph: string[] = [];
  const labels: string[] = [];
  req.segments.forEach((s, i) => {
    if (info.hasVideo) {
      graph.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
      labels.push(`[v${i}]`);
    }
    if (info.hasAudio) {
      graph.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[a${i}]`);
    }
  });
  const both = info.hasVideo && info.hasAudio;
  graph.push(
    `${labels.join("")}concat=n=${req.segments.length}:v=${info.hasVideo ? 1 : 0}:a=${info.hasAudio ? 1 : 0}` +
      (both ? "[outv][outa]" : "[out]"),
  );

  const maps: string[] = [];
  if (info.hasVideo) maps.push("-map", both ? "[outv]" : "[out]");
  if (info.hasAudio) maps.push("-map", both ? "[outa]" : "[out]");

  const total = req.segments.reduce((acc, s) => acc + (s.end - s.start), 0);
  await runEdit(
    "cut",
    [
      "-i", req.input,
      "-filter_complex", graph.join(";"),
      ...maps,
      ...(info.hasVideo ? H264_ARGS : ["-vn"]),
      ...(info.hasAudio ? AAC_ARGS : ["-an"]),
      ...flags,
      req.output,
    ],
    total,
    req.onProgress,
  );
  const out = await inspect(req.output);
  return { output: req.output, durationSec: out.durationSec || total, segments: req.segments.length };
}

export interface ConcatRequest {
  inputs: string[];
  output: string;
  /** Scale/pad/fps/audio-normalize every input before joining (default true). */
  normalize?: boolean;
  overwrite?: boolean;
  onProgress?: OnProgress;
}

export interface ConcatResult {
  output: string;
  durationSec: number;
  inputs: number;
  normalized: boolean;
}

const even = (n: number): number => Math.max(2, n % 2 === 0 ? n : n - 1);

function assertSameLayout(infos: MediaInfo[], kind: "video" | "audio"): void {
  const present = infos.filter((i) => (kind === "video" ? i.hasVideo : i.hasAudio)).length;
  if (present !== 0 && present !== infos.length) {
    throw new Error(`inputs mix files with and without an ${kind} stream; normalizing cannot join them`);
  }
}

/** Join several files into one. Compatible inputs are stream-copied when `normalize: false`. */
export async function concat(req: ConcatRequest): Promise<ConcatResult> {
  if (req.inputs.length < 2) throw new Error("concat needs at least two inputs");
  const flags = outputArgs(req.output, req.overwrite ?? false);
  const infos = await Promise.all(req.inputs.map((p) => inspect(p)));
  const total = infos.reduce((acc, i) => acc + i.durationSec, 0);
  const normalize = req.normalize ?? true;

  if (!normalize) {
    const dir = mkdtempSync(join(tmpdir(), "vem-concat-"));
    try {
      const list = join(dir, "inputs.txt");
      const escape = (p: string) => resolve(p).replace(/'/g, "'\\''");
      writeFileSync(list, req.inputs.map((p) => `file '${escape(p)}'`).join("\n") + "\n");
      await runEdit(
        "concat",
        ["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", ...flags, req.output],
        total,
        req.onProgress,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    assertSameLayout(infos, "video");
    assertSameLayout(infos, "audio");
    const withVideo = infos[0]?.hasVideo ?? false;
    const withAudio = infos[0]?.hasAudio ?? false;
    const width = even(Math.max(...infos.map((i) => i.width ?? 0)));
    const height = even(Math.max(...infos.map((i) => i.height ?? 0)));
    const fps = Math.max(1, ...infos.map((i) => i.fps ?? 30));

    const graph: string[] = [];
    const labels: string[] = [];
    infos.forEach((_, i) => {
      if (withVideo) {
        graph.push(
          `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
        );
        labels.push(`[v${i}]`);
      }
      if (withAudio) {
        graph.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
        labels.push(`[a${i}]`);
      }
    });
    const both = withVideo && withAudio;
    graph.push(
      `${labels.join("")}concat=n=${infos.length}:v=${withVideo ? 1 : 0}:a=${withAudio ? 1 : 0}` +
        (both ? "[outv][outa]" : "[out]"),
    );

    const maps: string[] = [];
    if (withVideo) maps.push("-map", both ? "[outv]" : "[out]");
    if (withAudio) maps.push("-map", both ? "[outa]" : "[out]");

    const inputArgs = req.inputs.flatMap((p) => ["-i", p]);
    await runEdit(
      "concat",
      [
        ...inputArgs,
        "-filter_complex", graph.join(";"),
        ...maps,
        ...(withVideo ? H264_ARGS : ["-vn"]),
        ...(withAudio ? AAC_ARGS : ["-an"]),
        ...flags,
        req.output,
      ],
      total,
      req.onProgress,
    );
  }

  const out = await inspect(req.output);
  return { output: req.output, durationSec: out.durationSec || total, inputs: req.inputs.length, normalized: normalize };
}
