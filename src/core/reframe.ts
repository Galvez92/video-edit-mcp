/**
 * Reframe a video to a different aspect ratio (9:16, 1:1, 16:9, 4:5) with a
 * centered crop, padding (solid or blurred background), or an optional
 * subject-following crop driven by lazy face detection.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ffmpeg, probe } from "./ffmpeg.js";
import {
  FACE_UNAVAILABLE,
  buildCropTrajectory,
  clampEven,
  loadFaceDetector,
} from "./face-track.js";

export type ReframeAspect = "9:16" | "1:1" | "16:9" | "4:5";
export type ReframeMode = "crop" | "pad" | "blur-pad";

export interface AspectRatio {
  w: number;
  h: number;
}

export const ASPECTS: Record<ReframeAspect, AspectRatio> = {
  "9:16": { w: 9, h: 16 },
  "1:1": { w: 1, h: 1 },
  "16:9": { w: 16, h: 9 },
  "4:5": { w: 4, h: 5 },
};

/** Encodes are far slower than probes; give ffmpeg room before the runner kills it. */
const ENCODE_TIMEOUT_MS = 600_000;
const tail = (text: string, length = 400): string => text.trim().slice(-length);

export interface ReframeInput {
  input: string;
  output: string;
  aspect: ReframeAspect;
  mode?: ReframeMode;
  /** Horizontal focus for the crop, 0 (left) .. 1 (right). Default 0.5 (center). */
  focusX?: number;
  /** Vertical focus for the crop, 0 (top) .. 1 (bottom). Default 0.5 (center). */
  focusY?: number;
  /** Follow the subject across time using lazy face detection (crop mode only). */
  follow?: boolean;
  /** Output height in pixels; defaults to the crop height (crop) or source height (pad). */
  height?: number;
  /** Pad color for mode "pad" (ffmpeg color spec, e.g. "black", "0x0000ff"). Default "black". */
  padColor?: string;
  overwrite?: boolean;
}

export interface ReframeResult {
  output: string;
  aspect: ReframeAspect;
  mode: ReframeMode;
  width: number;
  height: number;
  follow: boolean;
  durationSec: number;
}

/** Largest centered crop of `src` matching `aspect` (even dimensions). */
export function cropWindow(srcW: number, srcH: number, aspect: AspectRatio): { w: number; h: number } {
  const target = aspect.w / aspect.h;
  const src = srcW / srcH;
  let cw: number;
  let ch: number;
  if (src > target) {
    // source is wider: crop the sides, keep full height
    ch = srcH;
    cw = srcH * target;
  } else if (src < target) {
    // source is taller: crop top/bottom, keep full width
    cw = srcW;
    ch = srcW / target;
  } else {
    cw = srcW;
    ch = srcH;
  }
  return { w: clampEven(cw, 2, srcW), h: clampEven(ch, 2, srcH) };
}

/** Axis the crop removes pixels along (null when source already matches the aspect). */
export function croppedAxis(srcW: number, srcH: number, crop: { w: number; h: number }): "x" | "y" | null {
  if (crop.w < srcW) return "x";
  if (crop.h < srcH) return "y";
  return null;
}

/** Output dimensions for a crop: scaled to `outHeight` when given, else the crop size. */
export function cropOutput(
  crop: { w: number; h: number },
  aspect: AspectRatio,
  outHeight?: number,
): { w: number; h: number } {
  if (outHeight) {
    return { w: clampEven((outHeight * aspect.w) / aspect.h, 2, Infinity), h: clampEven(outHeight, 2, Infinity) };
  }
  return { w: crop.w, h: crop.h };
}

/** Even, clamped offset along an axis from a 0..1 focus value. */
export function focusOffset(focus: number | undefined, span: number): number {
  if (span <= 0) return 0;
  const f = clamp(focus ?? 0.5, 0, 1);
  return clampEven(f * span, 0, span);
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Reframe `input` and write `output`. */
export async function reframe(input: ReframeInput): Promise<ReframeResult> {
  const mode = input.mode ?? "crop";
  if (input.follow === true && mode !== "crop") {
    throw new Error('subject-follow is only supported in "crop" mode');
  }
  if (existsSync(input.output) && input.overwrite !== true) {
    throw new Error(`output already exists: ${input.output} (pass overwrite:true to replace it)`);
  }

  const info = await probe(input.input);
  const video = info.streams.find((stream) => stream.type === "video");
  if (video === undefined) throw new Error(`input has no video stream: ${input.input}`);
  const srcW = video.width ?? 0;
  const srcH = video.height ?? 0;
  if (!(srcW > 0 && srcH > 0)) throw new Error(`could not determine the resolution of: ${input.input}`);
  const durationSec = info.durationSec ?? 0;
  if (!(durationSec > 0)) throw new Error(`could not determine the duration of: ${input.input}`);

  const aspect = ASPECTS[input.aspect];
  const crop = cropWindow(srcW, srcH, aspect);

  let filter: string;
  let outW: number;
  let outH: number;
  let followUsed = false;

  if (mode === "crop") {
    const out = cropOutput(crop, aspect, input.height);
    outW = out.w;
    outH = out.h;
    let xExpr = String(focusOffset(input.focusX, srcW - crop.w));
    let yExpr = String(focusOffset(input.focusY, srcH - crop.h));
    if (input.follow === true) {
      const detector = await loadFaceDetector();
      if (detector === null) throw new Error(FACE_UNAVAILABLE);
      const detections = await detector.detect(input.input, { width: srcW, height: srcH });
      const traj = buildCropTrajectory(detections, { w: srcW, h: srcH }, crop);
      if (traj.axis === "x") xExpr = traj.expression;
      else if (traj.axis === "y") yExpr = traj.expression;
      followUsed = true;
    }
    filter = `crop=${crop.w}:${crop.h}:${xExpr}:${yExpr}`;
    if (outW !== crop.w || outH !== crop.h) filter += `,scale=${outW}:${outH}`;
  } else {
    const canvasH = input.height ? clampEven(input.height, 2, Infinity) : clampEven(srcH, 2, Infinity);
    outH = canvasH;
    outW = clampEven((canvasH * aspect.w) / aspect.h, 2, Infinity);
    const color = input.padColor ?? "black";
    if (mode === "pad") {
      filter =
        `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,` +
        `pad=${outW}:${outH}:(${outW}-iw)/2:(${outH}-ih)/2:color=${color}`;
    } else {
      filter =
        `[0:v]split=2[bg][fg];` +
        `[bg]boxblur=luma_radius=20:luma_power=2,scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}[bg2];` +
        `[fg]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg2];` +
        `[bg2][fg2]overlay=(${outW}-overlay_w)/2:(${outH}-overlay_h)/2[out]`;
    }
  }

  await mkdir(dirname(input.output), { recursive: true });
  const args =
    mode === "blur-pad"
      ? ["-y", "-i", input.input, "-filter_complex", filter, "-map", "[out]", "-map", "0:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", input.output]
      : ["-y", "-i", input.input, "-vf", filter, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", input.output];

  const result = await ffmpeg(args, ENCODE_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`ffmpeg failed (exit ${result.code}): ${tail(result.stderr)}`);

  return { output: input.output, aspect: input.aspect, mode, width: outW, height: outH, follow: followUsed, durationSec };
}
