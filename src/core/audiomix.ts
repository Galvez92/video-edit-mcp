/**
 * Audio mixing and loudness with ffmpeg: measure EBU R128 loudness, two-pass
 * loudness normalization, and voice+music mix with automatic ducking.
 *
 * ffmpeg/ffprobe are spawned as child processes (never via a shell). Times are
 * seconds; loudness in LUFS, true peak in dBTP.
 */
import { existsSync } from "node:fs";
import { ffmpeg, probe } from "./ffmpeg.js";

export interface LoudnessMeasure {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Extract the loudnorm JSON block ffmpeg prints to stderr. */
function parseLoudnorm(stderr: string): Record<string, string> | null {
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  return m ? (JSON.parse(m[0]) as Record<string, string>) : null;
}

/** Measure integrated loudness, true peak and loudness range of a media file. */
export async function measure(input: string): Promise<LoudnessMeasure> {
  if (!existsSync(input)) throw new Error(`input file not found: ${input}`);
  const r = await ffmpeg(["-nostats", "-i", input, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
  if (r.code !== 0) throw new Error(`ffmpeg loudnorm measurement failed: ${r.stderr.trim().slice(-400)}`);
  const m = parseLoudnorm(r.stderr);
  if (!m) throw new Error("could not parse loudnorm measurement");
  const integratedLufs = toNum(m.input_i);
  const truePeakDb = toNum(m.input_tp);
  const lra = toNum(m.input_lra);
  if ([integratedLufs, truePeakDb, lra].some(Number.isNaN)) {
    throw new Error(`incomplete loudnorm measurement: ${JSON.stringify(m)}`);
  }
  return { integratedLufs, truePeakDb, lra };
}

export interface LoudnormOptions {
  input: string;
  /** Target integrated loudness in LUFS (default -14). */
  targetLufs?: number;
  /** Target true peak in dBTP (default -1.5). */
  truePeak?: number;
  output: string;
}

export interface LoudnormResult {
  output: string;
  measured: LoudnessMeasure;
  normalized: LoudnessMeasure;
}

/** Two-pass loudness normalization to a target integrated loudness. */
export async function loudnorm(opts: LoudnormOptions): Promise<LoudnormResult> {
  const { input, output } = opts;
  const target = opts.targetLufs ?? -14;
  const truePeak = opts.truePeak ?? -1.5;
  if (!existsSync(input)) throw new Error(`input file not found: ${input}`);

  // Pass 1: measure.
  const p1 = await ffmpeg([
    "-nostats",
    "-i",
    input,
    "-af",
    `loudnorm=I=${target}:TP=${truePeak}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  if (p1.code !== 0) throw new Error(`loudnorm pass 1 failed: ${p1.stderr.trim().slice(-400)}`);
  const m = parseLoudnorm(p1.stderr);
  if (!m) throw new Error("could not parse loudnorm pass 1 measurement");
  const measured: LoudnessMeasure = {
    integratedLufs: toNum(m.input_i),
    truePeakDb: toNum(m.input_tp),
    lra: toNum(m.input_lra),
  };

  // Pass 2: linear normalization with the measured values.
  const af = `loudnorm=I=${target}:TP=${truePeak}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`;
  const p2 = await ffmpeg(["-y", "-i", input, "-af", af, output]);
  if (p2.code !== 0) throw new Error(`loudnorm pass 2 failed: ${p2.stderr.trim().slice(-400)}`);

  return { output, measured, normalized: await measure(output) };
}

export interface DuckOptions {
  /** Compressor threshold in dB (default -40). */
  threshold?: number;
  /** Compression ratio (default 10). */
  ratio?: number;
  /** Attack in milliseconds (default 5). */
  attack?: number;
  /** Release in milliseconds (default 300). */
  release?: number;
}

export interface MixOptions {
  /** Video (or media) file whose audio track is the voice. */
  video: string;
  /** Background music file. */
  music: string;
  /** Gain applied to the music in dB before ducking. */
  musicGainDb?: number;
  /** Sidechain-compressor ducking keyed on the voice. */
  duck?: DuckOptions;
  /** Fade-in duration in seconds (default 0). */
  fadeIn?: number;
  /** Fade-out duration in seconds (default 0). */
  fadeOut?: number;
  output: string;
}

export interface MixResult {
  output: string;
  durationSec: number;
  audioStreams: number;
}

/** Mix a video's voice track with background music, ducking the music under the voice. */
export async function mix(opts: MixOptions): Promise<MixResult> {
  const { video, music, output } = opts;
  for (const p of [video, music]) if (!existsSync(p)) throw new Error(`input file not found: ${p}`);

  const info = await probe(video);
  if (!info.streams.some((s) => s.type === "audio")) {
    throw new Error(`video has no audio track to mix: ${video}`);
  }
  const duration = info.durationSec ?? 0;
  const duck = { threshold: -40, ratio: 10, attack: 5, release: 300, ...opts.duck };
  const fadeIn = opts.fadeIn ?? 0;
  const fadeOut = opts.fadeOut ?? 0;

  // Force mono on both sources so sidechaincompress gets matching channel counts.
  const chains: string[] = [];
  chains.push("[0:a]aformat=channel_layouts=mono,asplit=2[voice][sc]");
  const musicGain = opts.musicGainDb !== undefined ? `,volume=${opts.musicGainDb}dB` : "";
  chains.push(`[1:a]aformat=channel_layouts=mono${musicGain}[music]`);
  // sidechaincompress threshold is a linear amplitude (ffmpeg range ~0.001–1); the
  // user-facing threshold is in dB, so convert it.
  const thresholdLin = Math.pow(10, duck.threshold / 20);
  chains.push(
    `[music][sc]sidechaincompress=threshold=${thresholdLin}:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}[ducked]`,
  );
  chains.push("[voice][ducked]amix=inputs=2:duration=first:normalize=0[mixed]");

  const fades: string[] = [];
  if (fadeIn > 0) fades.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) fades.push(`afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`);
  chains.push(fades.length ? `[mixed]${fades.join(",")}[out]` : "[mixed]anull[out]");

  const args = [
    "-y",
    "-i",
    video,
    "-i",
    music,
    "-filter_complex",
    chains.join(";"),
    "-map",
    "0:v?",
    "-c:v",
    "copy",
    "-map",
    "[out]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    output,
  ];
  const r = await ffmpeg(args);
  if (r.code !== 0) throw new Error(`audio mix failed: ${r.stderr.trim().slice(-400)}`);

  const out = await probe(output);
  return { output, durationSec: out.durationSec ?? 0, audioStreams: out.streams.filter((s) => s.type === "audio").length };
}
