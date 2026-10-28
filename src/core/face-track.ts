/**
 * Subject-follow for the reframe tool.
 *
 * Face detection is an *optional*, lazily-loaded integration: the reframe tool works
 * with a centered crop out of the box. Enabling `follow` asks a pluggable detector
 * (configured via the `REFRAME_FACE_MODULE` environment variable, pointing at a
 * module that exports a {@link FaceDetector}) for face centers over time, then the
 * pure trajectory math below turns those detections into a smooth, clamped,
 * even-dimensioned crop offset curve expressed as an ffmpeg `crop` filter argument.
 *
 * No detector is bundled here: keeping the server dependency-light and fully
 * offline means the detector is supplied by the operator when they want follow.
 */
export interface FaceDetection {
  /** Time of the detection, in seconds. */
  t: number;
  /** Face center X, normalized 0..1 (0 = left edge, 1 = right edge). */
  cx: number;
  /** Face center Y, normalized 0..1 (0 = top edge, 1 = bottom edge). */
  cy: number;
}

export interface FaceDetector {
  /** Sample faces from a video, returning their normalized centers over time. */
  detect(input: string, opts?: { width?: number; height?: number; fps?: number }): Promise<FaceDetection[]>;
}

export const FACE_UNAVAILABLE =
  'subject-follow is unavailable: no face detector is configured ' +
  "(set REFRAME_FACE_MODULE to a module exporting a FaceDetector, or drop the \"follow\" option for a centered crop)";

/**
 * Lazily resolve a pluggable face detector. Returns `null` when nothing is
 * configured or the configured module cannot be loaded, so the caller can fall
 * back to a clean `isError` rather than crashing.
 */
export async function loadFaceDetector(): Promise<FaceDetector | null> {
  const mod = process.env.REFRAME_FACE_MODULE;
  if (!mod) return null;
  try {
    const imported = await import(mod);
    const detector = (imported as { default?: FaceDetector }).default ?? (imported as FaceDetector);
    if (detector && typeof detector.detect === "function") return detector;
    return null;
  } catch {
    return null;
  }
}

export interface CropOffset {
  t: number;
  x: number;
  y: number;
}

export interface CropTrajectory {
  /** Axis the crop window slides along to keep the subject framed. */
  axis: "x" | "y" | null;
  /** One even, clamped offset per detection, sorted by time. */
  offsets: CropOffset[];
  /** ffmpeg `crop` filter argument (escaped) for the moving axis, or a constant. */
  expression: string;
}

/** Round to the nearest even integer, clamped to `[min, max]` (max may be Infinity). */
export function clampEven(value: number, min: number, max: number): number {
  let v = Math.round(value / 2) * 2;
  if (v < min) v = min;
  if (max !== Infinity && v > max) v = max;
  if (v % 2 !== 0) v -= 1; // nudge down to even
  if (v < min) v = min % 2 === 0 ? min : min + 1;
  return v;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Turn a time-ordered list of face centers into a crop-offset trajectory along the
 * axis the reframe actually crops (the other axis stays at 0). Offsets are clamped
 * to the available room and forced to even pixels so the resulting `crop` filter
 * keeps libx264's yuv420p happy. With no detections the trajectory collapses to a
 * single centered offset.
 */
export function buildCropTrajectory(
  detections: FaceDetection[],
  src: { w: number; h: number },
  crop: { w: number; h: number },
): CropTrajectory {
  const axis: "x" | "y" | null = crop.w < src.w ? "x" : crop.h < src.h ? "y" : null;
  const spanX = src.w - crop.w;
  const spanY = src.h - crop.h;
  const ordered = [...detections].sort((a, b) => a.t - b.t);

  const offsets: CropOffset[] = ordered.map((d) => {
    if (axis === "x") {
      const x = clampEven(clamp(d.cx * src.w - crop.w / 2, 0, spanX), 0, spanX);
      return { t: d.t, x, y: 0 };
    }
    if (axis === "y") {
      const y = clampEven(clamp(d.cy * src.h - crop.h / 2, 0, spanY), 0, spanY);
      return { t: d.t, x: 0, y };
    }
    return { t: d.t, x: 0, y: 0 };
  });

  if (offsets.length === 0 && axis !== null) {
    offsets.push({
      t: 0,
      x: axis === "x" ? clampEven(spanX / 2, 0, spanX) : 0,
      y: axis === "y" ? clampEven(spanY / 2, 0, spanY) : 0,
    });
  }

  const values = axis === "x" ? offsets.map((o) => o.x) : offsets.map((o) => o.y);
  const times = offsets.map((o) => o.t);
  return { axis, offsets, expression: expressionFor(values, times) };
}

/**
 * Build an ffmpeg boolean/expression string that piecewise-linearly interpolates the
 * crop offset over time. Commas are backslash-escaped because the whole string is a
 * single `crop` filter option (commas otherwise split the filter chain).
 */
function expressionFor(values: number[], times: number[]): string {
  if (values.length === 0) return "0";
  if (values.length === 1) return String(values[0]);
  const t = times.map((v) => Math.round(v * 1000) / 1000);
  let expr = String(values[values.length - 1]);
  for (let i = values.length - 2; i >= 0; i--) {
    const a = values[i];
    const b = values[i + 1];
    const ta = t[i];
    const tb = t[i + 1];
    const seg = tb > ta ? `${a}+(${b}-${a})*(t-${ta})/(${tb}-${ta})` : String(b);
    expr = `if(between(t,${ta},${tb}),${seg},${expr})`;
  }
  expr = `if(lt(t,${t[0]}),${values[0]},${expr})`;
  return expr.replace(/,/g, "\\,");
}
