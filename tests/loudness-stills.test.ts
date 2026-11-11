import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeliverySpec, PackageResult, RenderResult } from "../src/core/render.js";
import { programBreakdown, validateTimeline, type Timeline } from "../src/core/timeline.js";
import { buildTimelineGraph, stillChain } from "../src/core/timelineRender.js";
import { callTool, connectClient, hasFfmpeg, makeFixtures, makeTempDir } from "./helpers.js";

const tl = (clips: Timeline["tracks"][0]["clips"]): Timeline => ({ width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips }] });

describe("still clips (pure)", () => {
  it("uses durationSec as the still length and validates options", () => {
    expect(validateTimeline(tl([{ id: "s", src: "a.png", in: 0, out: 0, durationSec: 2 }]))).toEqual([]);
    expect(validateTimeline(tl([{ id: "s", src: "a.jpg", in: 0, out: 0 }])).join()).toMatch(/needs durationSec/);
    expect(validateTimeline(tl([{ id: "s", src: "a.webp", in: 0, out: 0, durationSec: 1, still: { kenBurns: { zoomTo: 9 } } }])).join()).toMatch(/zoomTo/);
    expect(validateTimeline(tl([{ id: "m", src: "a.mp4", in: 0, out: 1, still: { fit: "cover" } }])).join()).toMatch(/image source/);
  });

  it("builds a looped input, cover crop and a zoompan Ken Burns chain", () => {
    const g = buildTimelineGraph(
      tl([{ id: "s", src: "a.png", in: 0, out: 0, durationSec: 2, still: { fit: "cover", kenBurns: { zoomFrom: 1, zoomTo: 1.5, from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 } } } }]),
      { kind: "video", width: 320, height: 240, fps: 25 },
      { "a.png": { hasVideo: true, hasAudio: false } },
    );
    expect(g.inputArgs).toEqual(["-loop", "1", "-framerate", "25", "-t", "2", "-i", "a.png"]);
    expect(g.filterComplex).toMatch(/force_original_aspect_ratio=increase,crop=320:240/);
    expect(g.filterComplex).toMatch(/zoompan=z='\(1\+0\.5\*min\(on\/49,1\)\)'/);
    expect(g.filterComplex).toMatch(/anullsrc/);
    expect(stillChain({ id: "s", src: "a.png", in: 0, out: 0, durationSec: 1 }, 320, 240, 25)).not.toMatch(/zoompan/);
  });

  it("reports the program duration with transition overlaps removed", () => {
    const b = programBreakdown(tl([
      { id: "a", src: "a.png", in: 0, out: 0, durationSec: 2 },
      { id: "b", src: "b.mp4", in: 0, out: 2, transition: { type: "crossfade", durationSec: 0.5 } },
      { id: "c", src: "c.jpg", in: 0, out: 0, durationSec: 1, startSec: 4 },
    ]).tracks[0]);
    expect(b).toEqual({ durationSec: 5, clipsSec: 5, overlapSec: 0.5, gapSec: 0.5 });
  });
});

describe.skipIf(!hasFfmpeg)("stills + loudness render (require ffmpeg)", () => {
  let dir = "";
  let client: Client;
  beforeAll(async () => {
    dir = makeTempDir();
    makeFixtures(dir);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1", join(dir, "still.png")]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=200x400", "-frames:v", "1", join(dir, "tall.jpg")]);
    client = await connectClient();
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("renders stills (contain + cover Ken Burns) joined by transitions to a vertical preset", async () => {
    const output = join(dir, "stills.mp4");
    const r = await callTool<RenderResult>(client, "render", {
      preset: "vertical-9x16",
      output,
      timeline: {
        width: 1080, height: 1920, fps: 30,
        tracks: [{ id: "v", kind: "video", clips: [
          { id: "a", src: join(dir, "still.png"), durationSec: 1.5, still: { fit: "cover", kenBurns: { zoomTo: 1.3 } } },
          { id: "b", src: join(dir, "testsrc.mp4"), in: 0, out: 1.5, transition: { type: "dissolve", durationSec: 0.5 } },
          { id: "c", src: join(dir, "tall.jpg"), durationSec: 1, transition: { type: "crossfade", durationSec: 0.5 } },
        ] }],
      },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.width).toBe(1080);
    expect(r.data.height).toBe(1920);
    expect(r.data.program).toEqual({ durationSec: 3, clipsSec: 4, overlapSec: 1, gapSec: 0 });
    expect(r.data.durationSec).toBeGreaterThan(2.9);
    expect(r.data.durationSec).toBeLessThan(3.15);
    expect(r.data.audioCodec).toBe("aac");
  }, 120_000);

  it("rejects a media clip without in/out and a still on an audio track", async () => {
    const bad = await callTool(client, "render", { preset: "square", output: join(dir, "x.mp4"), timeline: { width: 1080, height: 1080, fps: 30, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: join(dir, "testsrc.mp4") }] }] } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/in and out are required/);
  });

  it("normalizes the final mix to -16 LUFS and packages before/after in spec.json", async () => {
    const output = join(dir, "loud.mp4");
    const r = await callTool<RenderResult>(client, "render", { input: join(dir, "testsrc.mp4"), preset: "square", output, loudness: {} });
    expect(r.isError, r.text).toBe(false);
    const l = r.data.loudness!;
    expect(l.target).toEqual({ targetLufs: -16, truePeakDb: -1, lra: 11 });
    expect(Math.abs(l.after.integratedLufs - -16)).toBeLessThan(1);
    expect(l.after.truePeakDbtp).toBeLessThanOrEqual(-0.5);
    expect(l.before.integratedLufs).not.toBeCloseTo(l.after.integratedLufs, 0);
    expect(existsSync(join(dir, "loud.loudness.json"))).toBe(true);
    const p = await callTool<PackageResult>(client, "export.package", { video: output, output: join(dir, "loud.zip") });
    expect(p.isError, p.text).toBe(false);
    const spec: DeliverySpec = p.data.spec;
    expect(spec.loudnessNormalization?.before.integratedLufs).toBe(l.before.integratedLufs);
    expect(spec.loudness?.integratedLufs).toBeCloseTo(l.after.integratedLufs, 1);
  }, 120_000);

  it("export.package can normalize itself with a custom target", async () => {
    const p = await callTool<PackageResult>(client, "export.package", { video: join(dir, "testsrc.mp4"), output: join(dir, "pkg.zip"), loudness: { targetLufs: -20, truePeakDb: -2 } });
    expect(p.isError, p.text).toBe(false);
    expect(Math.abs(p.data.spec.loudness!.integratedLufs - -20)).toBeLessThan(1);
    expect(p.data.spec.loudnessNormalization?.target.targetLufs).toBe(-20);
    expect(readFileSync(join(dir, "testsrc.mp4")).length).toBeGreaterThan(0);
  }, 120_000);

  it("is off by default (no loudness block, no sidecar)", async () => {
    const output = join(dir, "plain.mp4");
    const r = await callTool<RenderResult>(client, "render", { input: join(dir, "testsrc.mp4"), preset: "square", output });
    expect(r.data.loudness).toBeUndefined();
    expect(existsSync(join(dir, "plain.loudness.json"))).toBe(false);
  }, 120_000);
});
