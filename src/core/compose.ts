import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

/**
 * HyperFrames composition, loaded lazily as an optional peer dependency.
 * The ffmpeg tools never import it; when it is missing `compose` reports "unavailable".
 */
export const HYPERFRAMES_PKG = "@hyperframes/producer";

export interface ComposeAvailability {
  available: boolean;
  reason?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProducerModule = any;

let cached: Promise<ProducerModule | undefined> | undefined;

/** Import the optional peer at most once. */
export function loadProducer(pkg = HYPERFRAMES_PKG): Promise<ProducerModule | undefined> {
  if (pkg !== HYPERFRAMES_PKG) return import(pkg).catch(() => undefined);
  cached ??= import(pkg).catch(() => undefined);
  return cached;
}

export async function composeAvailability(pkg = HYPERFRAMES_PKG): Promise<ComposeAvailability> {
  const mod = await loadProducer(pkg);
  if (!mod) return { available: false, reason: `unavailable: optional peer ${pkg} is not installed (npm i ${pkg}; needs headless Chrome)` };
  return { available: true };
}

export type ComposeFormat = "mp4" | "webm" | "mov";

export interface ComposeRequest {
  /** Composition HTML file (its directory is the project root) or a project directory with index.html. */
  composition: string;
  output: string;
  /** Integer frame rate (default 30). Canvas size comes from the composition itself. */
  fps?: number;
  /** mp4 (opaque H.264), webm (VP9 + alpha) or mov (ProRes 4444 + alpha). Default: from the output extension, else mp4. */
  format?: ComposeFormat;
  quality?: "draft" | "standard" | "high";
}

export interface ComposeResult {
  output: string;
  format: ComposeFormat;
}

/** Producer logs go to stderr; keep only warnings/errors so stdio transports stay quiet. */
const quietLogger = {
  error: (m: string) => process.stderr.write(`[hyperframes] ${m}\n`),
  warn: (m: string) => process.stderr.write(`[hyperframes] ${m}\n`),
  info: () => {},
  debug: () => {},
  isLevelEnabled: (l: string) => l === "error" || l === "warn",
};

/**
 * Render a HyperFrames composition to video with `@hyperframes/producer` (createRenderJob/executeRenderJob).
 * Throws "unavailable: ..." when the optional peer is missing; render failures are rethrown with the producer message.
 */
export async function compose(req: ComposeRequest, pkg = HYPERFRAMES_PKG): Promise<ComposeResult> {
  const mod = await loadProducer(pkg);
  if (!mod) throw new Error((await composeAvailability(pkg)).reason);
  if (typeof mod.createRenderJob !== "function" || typeof mod.executeRenderJob !== "function")
    throw new Error(`unavailable: ${pkg} exposes no createRenderJob/executeRenderJob`);
  if (!existsSync(req.composition)) throw new Error(`composition not found: ${req.composition}`);
  const isDir = statSync(req.composition).isDirectory();
  const projectDir = resolve(isDir ? req.composition : dirname(req.composition));
  const entryFile = isDir ? "index.html" : basename(req.composition);
  const ext = extname(req.output).slice(1).toLowerCase();
  const format: ComposeFormat = req.format ?? (ext === "webm" || ext === "mov" ? ext : "mp4");
  const fps = Math.round(req.fps ?? 30);
  const job = mod.createRenderJob({ fps, quality: req.quality ?? "standard", format, entryFile, logger: quietLogger });
  try {
    await mod.executeRenderJob(job, projectDir, resolve(req.output));
  } catch (err) {
    throw new Error(`hyperframes render failed: ${(err as Error).message}`, { cause: err });
  }
  if (!existsSync(req.output)) throw new Error(`hyperframes render produced no file at ${req.output}`);
  return { output: req.output, format };
}
