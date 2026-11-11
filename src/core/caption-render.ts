/**
 * Caption burn-in: build the caption layer (HyperFrames alpha layer, or a libass
 * ASS overlay for the ffmpeg fallback), then mux it onto the source video and
 * keep the source audio.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCompositionHtml } from "./captions.js";
import { ffmpeg, probe } from "./ffmpeg.js";
import { UNAVAILABLE_MESSAGE, loadProducer, renderLayer } from "./hyperframes.js";
import { formatAss, type CaptionStyleName, type SubtitleCue } from "./subtitles.js";

export type CaptionEngine = "hyperframes" | "ffmpeg";

/** Encodes are far slower than probes; give ffmpeg room before the runner kills it. */
const ENCODE_TIMEOUT_MS = 600_000;

/** Escape a path for use inside an ffmpeg filtergraph argument (this is not a shell argument). */
const escapeFilterPath = (path: string): string => path.replace(/([\\':[\],;])/g, "\\$1");

const tail = (text: string, length = 400): string => text.trim().slice(-length);

export interface RenderCaptionsInput {
  input: string;
  output: string;
  /** Defaults to `hyperframes`; pass `ffmpeg` for the libass fallback. */
  engine?: CaptionEngine;
  style?: CaptionStyleName;
  /** Caption chunks to burn in; required unless `compositionPath` is given. */
  cues?: SubtitleCue[];
  /** Pre-built composition HTML (from `captions.generate`), HyperFrames engine only. */
  compositionPath?: string;
  width?: number;
  height?: number;
  fps?: number;
  overwrite?: boolean;
  /** Replaces the default video encode args (`-c:v libx264 -pix_fmt yuv420p`), e.g. a delivery preset's. */
  videoEncodeArgs?: string[];
}

export interface RenderCaptionsResult {
  output: string;
  engine: CaptionEngine;
  cues: number;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

/** Render captions onto `input` and write `output`. */
export async function renderCaptions(input: RenderCaptionsInput): Promise<RenderCaptionsResult> {
  const engine = input.engine ?? "hyperframes";
  if (existsSync(input.output) && input.overwrite !== true) {
    throw new Error(`output already exists: ${input.output} (pass overwrite:true to replace it)`);
  }

  if (engine === "hyperframes" && (await loadProducer()) === null) throw new Error(UNAVAILABLE_MESSAGE);

  const info = await probe(input.input);
  const video = info.streams.find((stream) => stream.type === "video");
  if (video === undefined) throw new Error(`input has no video stream: ${input.input}`);
  const width = Math.round(input.width ?? video.width ?? 1080);
  const height = Math.round(input.height ?? video.height ?? 1920);
  const fps = input.fps ?? video.fps ?? 30;
  const durationSec = info.durationSec ?? 0;
  if (!(durationSec > 0)) throw new Error(`could not determine the duration of: ${input.input}`);
  if (engine === "ffmpeg" && (input.cues?.length ?? 0) === 0) {
    throw new Error('engine "ffmpeg" needs caption cues: pass transcript segments or an srt path');
  }

  const workDir = await mkdtemp(join(tmpdir(), "vem-captions-"));
  try {
    const args =
      engine === "ffmpeg"
        ? await burnInWithAss(input, { width, height }, workDir)
        : await composeWithHyperFrames(input, { width, height, fps, durationSec }, workDir);
    await mkdir(dirname(input.output), { recursive: true });
    const result = await ffmpeg([...args, input.output], ENCODE_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new Error(`ffmpeg failed (exit ${result.code}): ${tail(result.stderr)}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  return {
    output: input.output,
    engine,
    cues: input.cues?.length ?? 0,
    width,
    height,
    fps: Math.round(fps * 1000) / 1000,
    durationSec,
  };
}

interface Size {
  width: number;
  height: number;
}

/** ffmpeg fallback: a styled ASS file burned in with libass. */
async function burnInWithAss(input: RenderCaptionsInput, size: Size, workDir: string): Promise<string[]> {
  const assPath = join(workDir, "captions.ass");
  await writeFile(assPath, formatAss(input.cues ?? [], { style: input.style, width: size.width, height: size.height }), "utf8");
  return [
    "-y",
    "-i",
    input.input,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    `ass=${escapeFilterPath(assPath)}`,
    ...(input.videoEncodeArgs ?? ["-c:v", "libx264", "-pix_fmt", "yuv420p"]),
    "-c:a",
    "copy",
  ];
}

/** Primary engine: render the caption composition to an alpha layer, then overlay it. */
async function composeWithHyperFrames(
  input: RenderCaptionsInput,
  size: Size & { fps: number; durationSec: number },
  workDir: string,
): Promise<string[]> {
  const html =
    input.compositionPath !== undefined
      ? await readFile(input.compositionPath, "utf8")
      : buildCompositionHtml(input.cues ?? [], {
          style: input.style,
          width: size.width,
          height: size.height,
          duration: size.durationSec,
        });
  if (html.trim() === "") throw new Error("caption composition is empty");

  const layer = await renderLayer({ html, fps: size.fps, dir: join(workDir, "hyperframes") });
  return [
    "-y",
    "-i",
    input.input,
    "-i",
    layer.path,
    "-filter_complex",
    "[0:v][1:v]overlay=0:0:shortest=0[outv]",
    "-map",
    "[outv]",
    "-map",
    "0:a?",
    ...(input.videoEncodeArgs ?? ["-c:v", "libx264", "-pix_fmt", "yuv420p"]),
    "-c:a",
    "copy",
  ];
}
