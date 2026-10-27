import { spawn } from "node:child_process";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a binary without a shell; resolves with exit code and captured output. */
export function run(bin: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
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
