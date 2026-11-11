/**
 * Adapter for the optional HyperFrames producer peer (`@hyperframes/producer`).
 *
 * The package pulls a headless Chrome, so it is never a dependency of this
 * server: it is imported lazily on first use and its absence simply makes the
 * HyperFrames engine report `unavailable`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HYPERFRAMES_PACKAGE = "@hyperframes/producer";

export const UNAVAILABLE_MESSAGE =
  `HyperFrames engine unavailable: install the optional peer ${HYPERFRAMES_PACKAGE} ` +
  "(Node 22+ and a headless Chrome) or call this tool with engine \"ffmpeg\".";

/** Alpha-capable layer format: ProRes 4444 decodes with alpha in every ffmpeg build. */
export type LayerFormat = "mov" | "webm";

const DEFAULT_LAYER_FORMAT: LayerFormat = "mov";

/** The slice of the producer's public API this server uses. */
export interface ProducerLike {
  createRenderJob: (config: ProducerRenderConfig) => unknown;
  executeRenderJob: (job: unknown, projectDir: string, outputPath: string) => Promise<void>;
}

export interface ProducerRenderConfig {
  /** Frame rate as an exact rational `{ num, den }`. */
  fps: { num: number; den: number };
  quality: "draft" | "standard" | "high";
  format: LayerFormat;
  workers?: number;
}

let loading: Promise<ProducerLike | null> | undefined;

/** Import the producer once per process; `null` means it is not installed or unusable. */
export function loadProducer(): Promise<ProducerLike | null> {
  loading ??= import(HYPERFRAMES_PACKAGE)
    .then((module) => {
      const candidate = module as unknown as Partial<ProducerLike>;
      const usable =
        typeof candidate.createRenderJob === "function" && typeof candidate.executeRenderJob === "function";
      return usable ? (candidate as ProducerLike) : null;
    })
    .catch(() => null);
  return loading;
}

export interface LayerRequest {
  /** Composition HTML; the engine injects its runtime before capturing frames. */
  html: string;
  fps: number;
  /** Working directory for the composition and its output (created if missing). */
  dir: string;
  format?: LayerFormat;
}

export interface LayerResult {
  path: string;
  format: LayerFormat;
}

/** Render a composition to an alpha layer file. Throws `UNAVAILABLE_MESSAGE` without the peer. */
export async function renderLayer(request: LayerRequest): Promise<LayerResult> {
  const producer = await loadProducer();
  if (producer === null) throw new Error(UNAVAILABLE_MESSAGE);

  const format = request.format ?? DEFAULT_LAYER_FORMAT;
  await mkdir(request.dir, { recursive: true });
  await writeFile(join(request.dir, "index.html"), request.html, "utf8");
  const outputPath = join(request.dir, `caption-layer.${format}`);
  const job = producer.createRenderJob({
    fps: { num: Math.max(1, Math.round(request.fps)), den: 1 },
    quality: "standard",
    format,
    workers: 1,
  });
  await producer.executeRenderJob(job, request.dir, outputPath);
  return { path: outputPath, format };
}
