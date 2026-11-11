import { spawn } from "node:child_process";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a binary without a shell; resolves with exit code and captured output.
 * `onStdout` receives raw stdout chunks as they arrive (used for ffmpeg progress).
 */
export function run(
  bin: string,
  args: string[],
  timeoutMs = 120_000,
  onStdout?: (chunk: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      const text = String(d);
      stdout += text;
      onStdout?.(text);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export const ffmpeg = (args: string[], timeoutMs?: number) => run(FFMPEG, ["-hide_banner", ...args], timeoutMs);
export const ffprobe = (args: string[], timeoutMs?: number) => run(FFPROBE, ["-hide_banner", ...args], timeoutMs);

export interface ProgressUpdate {
  /** Seconds of output produced so far. */
  outTimeSec: number;
  frame?: number;
  fps?: number;
  speed?: string;
  done: boolean;
}

/** `out_time` is a `HH:MM:SS.micro` timestamp; `out_time_us`/`out_time_ms` are microseconds. */
function toSeconds(fields: Record<string, string>): number {
  if (fields.out_time_us) return Number(fields.out_time_us) / 1e6;
  if (fields.out_time_ms) return Number(fields.out_time_ms) / 1e6;
  const stamp = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(fields.out_time ?? "");
  if (stamp) return Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]);
  const n = Number(fields.out_time ?? "");
  return Number.isFinite(n) ? n : 0;
}

function toUpdate(fields: Record<string, string>): ProgressUpdate {
  const num = (v?: string) => {
    const n = Number(v);
    return v === undefined || Number.isNaN(n) ? undefined : n;
  };
  return {
    outTimeSec: toSeconds(fields),
    frame: num(fields.frame),
    fps: num(fields.fps),
    speed: fields.speed,
    done: fields.progress === "end",
  };
}

/**
 * Incremental parser for `ffmpeg -progress pipe:1` output: blocks of `key=value`
 * lines ending with `progress=continue|end`. Chunks may split lines anywhere.
 */
export function createProgressParser(onUpdate: (update: ProgressUpdate) => void): (chunk: string) => void {
  let buffer = "";
  let fields: Record<string, string> = {};
  return (chunk: string): void => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      fields[key] = line.slice(eq + 1).trim();
      if (key === "progress") {
        onUpdate(toUpdate(fields));
        fields = {};
      }
    }
  };
}

/**
 * Run ffmpeg with `-progress pipe:1` and report progress as it is produced.
 * Progress uses stdout, so this is only for runs that write their output to a file.
 */
export function ffmpegWithProgress(
  args: string[],
  onProgress?: (update: ProgressUpdate) => void,
  timeoutMs = 120_000,
): Promise<RunResult> {
  if (!onProgress) return ffmpeg(args, timeoutMs);
  const parse = createProgressParser(onProgress);
  return run(FFMPEG, ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args], timeoutMs, parse);
}

export interface BinaryStatus {
  available: boolean;
  version?: string;
  error?: string;
}

async function checkBinary(bin: string): Promise<BinaryStatus> {
  try {
    const r = await run(bin, ["-version"], 10_000);
    if (r.code !== 0) return { available: false, error: r.stderr.trim() || `exit ${r.code}` };
    return { available: true, version: r.stdout.split("\n")[0]?.trim() };
  } catch (err) {
    return { available: false, error: (err as Error).message };
  }
}

export async function health(): Promise<{ ffmpeg: BinaryStatus; ffprobe: BinaryStatus; ok: boolean }> {
  const [f, p] = await Promise.all([checkBinary(FFMPEG), checkBinary(FFPROBE)]);
  return { ffmpeg: f, ffprobe: p, ok: f.available && p.available };
}

export interface StreamInfo {
  index: number;
  type: "video" | "audio" | "subtitle" | "data" | string;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  durationSec?: number;
}

export interface ProbeResult {
  path: string;
  format?: string;
  durationSec?: number;
  sizeBytes?: number;
  bitRate?: number;
  streams: StreamInfo[];
}

function parseRate(rate?: string): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === undefined || Number.isNaN(n) ? undefined : n;
};

/** Inspect a media file with ffprobe and return a normalized summary. */
export async function probe(path: string): Promise<ProbeResult> {
  const r = await ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = JSON.parse(r.stdout) as { format?: any; streams?: any[] };
  return {
    path,
    format: j.format?.format_name,
    durationSec: num(j.format?.duration),
    sizeBytes: num(j.format?.size),
    bitRate: num(j.format?.bit_rate),
    streams: (j.streams ?? []).map((s) => ({
      index: s.index,
      type: s.codec_type,
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      fps: s.codec_type === "video" ? parseRate(s.avg_frame_rate) : undefined,
      sampleRate: num(s.sample_rate),
      channels: s.channels,
      durationSec: num(s.duration),
    })),
  };
}
