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

export interface ComposeRequest {
  composition: string;
  output: string;
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * Render a HyperFrames composition (HTML file) to video. The producer API is resolved at runtime;
 * this throws "unavailable" when the peer is missing or exposes no known render entry point.
 */
export async function compose(req: ComposeRequest, pkg = HYPERFRAMES_PKG): Promise<{ output: string }> {
  const mod = await loadProducer(pkg);
  if (!mod) throw new Error((await composeAvailability(pkg)).reason);
  const renderFn = mod.render ?? mod.renderComposition ?? mod.default?.render;
  if (typeof renderFn !== "function") throw new Error(`unavailable: ${pkg} exposes no render() entry point`);
  await renderFn({ input: req.composition, output: req.output, width: req.width, height: req.height, fps: req.fps });
  return { output: req.output };
}
