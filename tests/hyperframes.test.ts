import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose } from "../src/core/compose.js";
import { probe } from "../src/core/ffmpeg.js";
import { render } from "../src/core/render.js";
import { hyperframesReady, makeFixtures, makeTempDir, pixelAt, titleComposition } from "./helpers.js";

// Real HyperFrames renders: skipped automatically without @hyperframes/producer + headless Chrome.
const ready = await hyperframesReady();
const isRed = ([r, g, b]: number[]) => r! > 160 && g! < 70 && b! < 70;

describe.skipIf(!ready)("HyperFrames compose (requires @hyperframes/producer + Chrome)", () => {
  let dir = "";
  beforeAll(() => {
    dir = makeTempDir();
    makeFixtures(dir);
    mkdirSync(join(dir, "proj"));
    mkdirSync(join(dir, "layer"));
    copyFileSync(join(dir, "testsrc.mp4"), join(dir, "proj", "clip.mp4"));
    writeFileSync(join(dir, "proj", "index.html"), titleComposition("clip.mp4"));
    writeFileSync(join(dir, "layer", "title.html"), titleComposition(undefined));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("renders a title over a fixture clip to mp4", async () => {
    const output = join(dir, "composed.mp4");
    const res = await compose({ composition: join(dir, "proj"), output, fps: 25, quality: "draft" });
    expect(res.format).toBe("mp4");
    const p = await probe(output);
    expect(p.streams.find((s) => s.type === "video")).toMatchObject({ codec: "h264", width: 320, height: 240 });
    expect(p.durationSec).toBeCloseTo(2, 1);
    // Title band is red; outside it the source pattern is unchanged.
    expect(isRed(pixelAt(output, 1, 10, 100))).toBe(true);
    expect(isRed(pixelAt(join(dir, "testsrc.mp4"), 1, 10, 100))).toBe(false);
  }, 180_000);

  it("render composites a HyperFrames alpha layer over a timeline", async () => {
    const output = join(dir, "layered.mp4");
    const res = await render({
      timeline: { width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: join(dir, "testsrc.mp4"), in: 0, out: 2 }] }] },
      preset: "web-1080p",
      output,
      hyperframes: join(dir, "layer", "title.html"),
    });
    expect(res.overlay).toBe("hyperframes");
    const p = await probe(output);
    expect(p.streams.find((s) => s.type === "video")).toMatchObject({ width: 1920, height: 1080 });
    expect(p.durationSec).toBeCloseTo(2, 1);
    // Layer is scaled to the full frame: title band at y 90–138 of 240 → ~405–620 of 1080.
    expect(isRed(pixelAt(output, 1, 960, 510))).toBe(true);
    // Transparent area of the layer keeps the program (top row is the source/pad, not red).
    expect(isRed(pixelAt(output, 1, 960, 100))).toBe(false);
  }, 180_000);

  it("render offsets the HyperFrames layer with layerStartSec", async () => {
    const output = join(dir, "layered-late.mp4");
    await render({
      timeline: { width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: join(dir, "testsrc.mp4"), in: 0, out: 2 }] }] },
      preset: "web-1080p",
      output,
      hyperframes: join(dir, "layer", "title.html"),
      layerStartSec: 1,
    });
    expect((await probe(output)).durationSec).toBeCloseTo(2, 1);
    expect(isRed(pixelAt(output, 0.5, 960, 510))).toBe(false);
    expect(isRed(pixelAt(output, 1.5, 960, 510))).toBe(true);
  }, 180_000);
});
