import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProbeResult } from "../src/core/ffmpeg.js";
import type { RenderResult } from "../src/core/render.js";
import type { Timeline } from "../src/core/timeline.js";
import { buildTimelineGraph } from "../src/core/timelineRender.js";
import { execFileSync, spawnSync } from "node:child_process";
import { callTool, connectClient, hasFfmpeg, makeFixtures, makeTempDir, pixelAt } from "./helpers.js";

const both = { hasVideo: true, hasAudio: true };

describe("buildTimelineGraph", () => {
  const tl: Timeline = {
    width: 1080, height: 1920, fps: 30,
    tracks: [
      { id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0.5, out: 1.5 }, { id: "b", src: "s.mp4", in: 0, out: 1 }] },
      { id: "m", kind: "audio", clips: [{ id: "c", src: "m.wav", in: 0, out: 2, gainDb: -6 }] },
      { id: "cap", kind: "caption", clips: [{ id: "t", src: "x.srt", in: 0, out: 2 }] },
    ],
  };
  const src = { "a.mp4": both, "s.mp4": { hasVideo: true, hasAudio: false }, "m.wav": { hasVideo: false, hasAudio: true } };

  it("trims inputs, fills silence, concats and mixes music", () => {
    const g = buildTimelineGraph(tl, { kind: "video", width: 1080, height: 1920, fps: 30 }, src);
    expect(g.inputArgs.slice(0, 6)).toEqual(["-ss", "0.5", "-t", "1", "-i", "a.mp4"]);
    expect(g.filterComplex).toContain("anullsrc");
    expect(g.filterComplex).toContain("concat=n=2:v=1:a=1[pv][pa]");
    expect(g.filterComplex).toContain("volume=-6dB");
    expect(g.filterComplex).toContain("amix=inputs=2:duration=first");
    expect(g.maps).toEqual(["[pv]", "[aout]"]);
    expect(g.durationSec).toBe(2);
  });
  it("adds an alpha overlay decoded with libvpx-vp9", () => {
    const g = buildTimelineGraph(tl, { kind: "video", width: 1080, height: 1920, fps: 30 }, src, { overlay: "o.webm" });
    expect(g.inputArgs.slice(-4)).toEqual(["-c:v", "libvpx-vp9", "-i", "o.webm"]);
    expect(g.maps[0]).toBe("[vout]");
  });
  it("audio target builds no video", () => {
    const g = buildTimelineGraph(tl, { kind: "audio" }, src);
    expect(g.filterComplex).not.toContain("[pv]");
    expect(g.maps).toEqual(["[aout]"]);
  });
  it("rejects invalid timelines and missing streams", () => {
    expect(() => buildTimelineGraph({ ...tl, tracks: [] }, { kind: "audio" }, src)).toThrow(/invalid timeline/);
    const noVideo = { ...src, "a.mp4": { hasVideo: false, hasAudio: true } };
    expect(() => buildTimelineGraph(tl, { kind: "video", width: 2, height: 2, fps: 30 }, noVideo)).toThrow(/no video stream/);
  });
});


describe("timeline placement and transitions (graph)", () => {
  const V = { kind: "video" as const, width: 320, height: 240, fps: 25 };
  const src = { "a.mp4": both, "b.mp4": both };
  const mk = (clips: Timeline["tracks"][number]["clips"]): Timeline => ({ width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips }] });

  it("joins clips with xfade + acrossfade at the right offset", () => {
    const g = buildTimelineGraph(mk([
      { id: "a", src: "a.mp4", in: 0, out: 2 },
      { id: "b", src: "b.mp4", in: 0, out: 1, transition: { type: "crossfade", durationSec: 0.5 } },
      { id: "c", src: "a.mp4", in: 0, out: 1, transition: { type: "wipeleft", durationSec: 0.25 } },
    ]), V, src);
    expect(g.filterComplex).toContain("xfade=transition=fade:duration=0.5:offset=1.5");
    expect(g.filterComplex).toContain("xfade=transition=wipeleft:duration=0.25:offset=2.25");
    expect(g.filterComplex).toContain("acrossfade=d=0.5");
    expect(g.durationSec).toBeCloseTo(3.25, 6);
  });
  it("fills gaps with black + silence", () => {
    const g = buildTimelineGraph(mk([{ id: "a", src: "a.mp4", in: 0, out: 1, startSec: 0.5 }, { id: "b", src: "b.mp4", in: 0, out: 1, startSec: 3 }]), V, src);
    expect(g.filterComplex).toContain("color=c=black:s=320x240:r=25:d=0.5");
    expect(g.filterComplex).toContain("color=c=black:s=320x240:r=25:d=1.5");
    expect(g.filterComplex).toContain("concat=n=4:v=1:a=1");
    expect(g.durationSec).toBe(4);
  });
  it("rejects overlaps, over-long transitions and transitions on the first clip", () => {
    expect(() => buildTimelineGraph(mk([{ id: "a", src: "a.mp4", in: 0, out: 2 }, { id: "b", src: "b.mp4", in: 0, out: 1, startSec: 1 }]), V, src)).toThrow(/overlaps clip a.*transition/);
    expect(() => buildTimelineGraph(mk([{ id: "a", src: "a.mp4", in: 0, out: 2 }, { id: "b", src: "b.mp4", in: 0, out: 1, transition: { type: "dissolve", durationSec: 1.5 } }]), V, src)).toThrow(/longer than a neighbouring clip/);
    expect(() => buildTimelineGraph(mk([{ id: "a", src: "a.mp4", in: 0, out: 2, transition: { type: "fadeblack", durationSec: 0.5 } }]), V, src)).toThrow(/first clip/);
  });
  it("delays audio-track clips and offsets the overlay layer", () => {
    const tl: Timeline = { ...mk([{ id: "a", src: "a.mp4", in: 0, out: 2 }]), tracks: [...mk([{ id: "a", src: "a.mp4", in: 0, out: 2 }]).tracks, { id: "m", kind: "audio", clips: [{ id: "t", src: "b.mp4", in: 0, out: 1, startSec: 0.75 }] }] };
    const g = buildTimelineGraph(tl, V, src, { overlay: "o.mov", layerStartSec: 1, layerDurationSec: 0.5 });
    expect(g.filterComplex).toContain("adelay=750:all=1");
    expect(g.filterComplex).toContain("setpts=PTS-STARTPTS+1/TB");
    expect(g.filterComplex).toContain("enable='between(t,1,1.5)'");
  });
});

describe.skipIf(!hasFfmpeg)("render from a timeline (requires ffmpeg)", () => {
  let dir = "";
  let client: Client;
  const f = (n: string) => join(dir, n);
  beforeAll(async () => {
    dir = makeTempDir();
    makeFixtures(dir);
    client = await connectClient();
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const probeOut = async (p: string) => (await callTool<ProbeResult>(client, "probe", { path: p })).data;

  it("assembles clips with in/out, mixed geometry, a silent clip and a music bed", async () => {
    const timeline: Timeline = {
      width: 1080, height: 1920, fps: 30,
      tracks: [
        {
          id: "v", kind: "video", clips: [
            { id: "a", src: f("testsrc.mp4"), in: 0.5, out: 1.5 },
            { id: "b", src: f("testsrc-wide.mp4"), in: 0, out: 0.8 },
            { id: "c", src: f("silent.mp4"), in: 0, out: 0.7 },
          ],
        },
        { id: "m", kind: "audio", clips: [{ id: "t", src: f("tone.wav"), in: 0, out: 2, gainDb: -12 }] },
      ],
    };
    const output = f("tl-vertical.mp4");
    const res = await callTool<RenderResult>(client, "render", { timeline, preset: "vertical-9x16", output });
    expect(res.isError, res.text).toBe(false);
    const p = await probeOut(output);
    expect(p.streams.find((s) => s.type === "video")).toMatchObject({ codec: "h264", width: 1080, height: 1920, fps: 30 });
    expect(p.streams.find((s) => s.type === "audio")).toMatchObject({ codec: "aac", sampleRate: 48000, channels: 2 });
    expect(p.durationSec).toBeGreaterThan(2.4);
    expect(p.durationSec).toBeLessThan(2.6);
  });

  it("audio-only preset renders the timeline audio", async () => {
    const timeline: Timeline = {
      width: 320, height: 240, fps: 25,
      tracks: [{ id: "m", kind: "audio", clips: [{ id: "a", src: f("tone.wav"), in: 0.5, out: 1.75 }] }],
    };
    const output = f("tl.m4a");
    const res = await callTool<RenderResult>(client, "render", { timeline, preset: "audio-only", output });
    expect(res.isError, res.text).toBe(false);
    const p = await probeOut(output);
    expect(p.streams.some((s) => s.type === "video")).toBe(false);
    expect(p.durationSec).toBeGreaterThan(1.15);
    expect(p.durationSec).toBeLessThan(1.35);
  });

  const isBlack = ([r, g, b]: number[]) => r! < 30 && g! < 30 && b! < 30;
  const isRed = ([r, g, b]: number[]) => r! > 160 && g! < 70 && b! < 70;
  /** Mean volume (dB) of `file` between `ss` and `ss + t`. */
  const meanVolume = (file: string, ss: number, t: number): number => {
    const r = spawnSync("ffmpeg", ["-v", "info", "-ss", String(ss), "-t", String(t), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r);
    return m ? (m[1] === "-inf" ? -200 : Number(m[1])) : -200;
  };

  it("transitions: duration is the sum minus the overlaps (crossfade, fadeblack, wipe, slide)", async () => {
    const timeline: Timeline = {
      width: 320, height: 240, fps: 25,
      tracks: [{
        id: "v", kind: "video", clips: [
          { id: "a", src: f("testsrc.mp4"), in: 0, out: 1.5 },
          { id: "b", src: f("testsrc-b.mp4"), in: 0, out: 1, transition: { type: "crossfade", durationSec: 0.5 } },
          { id: "c", src: f("silent.mp4"), in: 0, out: 1, transition: { type: "fadeblack", durationSec: 0.4 } },
          { id: "d", src: f("testsrc-wide.mp4"), in: 0, out: 1, transition: { type: "wipeleft", durationSec: 0.3 } },
          { id: "e", src: f("testsrc.mp4"), in: 0, out: 1, transition: { type: "slideright", durationSec: 0.2 } },
        ],
      }],
    };
    const output = f("tl-xfade.mp4");
    const res = await callTool<RenderResult>(client, "render", { timeline, preset: "square", output });
    expect(res.isError, res.text).toBe(false);
    const p = await probeOut(output);
    // 1.5 + 4×1 − (0.5 + 0.4 + 0.3 + 0.2) = 4.1 s
    expect(p.durationSec).toBeGreaterThan(4.0);
    expect(p.durationSec).toBeLessThan(4.2);
    expect(p.streams.find((s) => s.type === "audio")).toMatchObject({ codec: "aac" });
  });

  it("startSec gaps render black (and silent) between clips", async () => {
    const timeline: Timeline = {
      width: 320, height: 240, fps: 25,
      tracks: [{ id: "v", kind: "video", clips: [
        { id: "a", src: f("testsrc.mp4"), in: 0, out: 1 },
        { id: "b", src: f("testsrc-b.mp4"), in: 0, out: 1, startSec: 2 },
      ] }],
    };
    const output = f("tl-gap.mp4");
    const res = await callTool<RenderResult>(client, "render", { timeline, preset: "square", output });
    expect(res.isError, res.text).toBe(false);
    const p = await probeOut(output);
    expect(p.durationSec).toBeGreaterThan(2.9);
    expect(p.durationSec).toBeLessThan(3.1);
    // Centre of the frame: pattern at 0.5 s and 2.5 s, black inside the gap.
    expect(isBlack(pixelAt(output, 0.5, 540, 540))).toBe(false);
    expect(isBlack(pixelAt(output, 1.5, 540, 540))).toBe(true);
    expect(isBlack(pixelAt(output, 2.5, 540, 540))).toBe(false);
    expect(meanVolume(output, 1.2, 0.6)).toBeLessThan(-80);
    expect(meanVolume(output, 0.2, 0.6)).toBeGreaterThan(-40);
  });

  it("audio-track startSec delays the clip (silence before it)", async () => {
    const timeline: Timeline = {
      width: 320, height: 240, fps: 25,
      tracks: [{ id: "m", kind: "audio", clips: [{ id: "a", src: f("tone.wav"), in: 0, out: 1, startSec: 1 }] }],
    };
    const output = f("tl-delay.m4a");
    const res = await callTool<RenderResult>(client, "render", { timeline, preset: "audio-only", output });
    expect(res.isError, res.text).toBe(false);
    expect((await probeOut(output)).durationSec).toBeGreaterThan(1.9);
    expect(meanVolume(output, 0.1, 0.7)).toBeLessThan(-80);
    expect(meanVolume(output, 1.2, 0.6)).toBeGreaterThan(-40);
  });

  it("overlap without a transition is rejected with a clear error", async () => {
    const timeline: Timeline = { width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips: [
      { id: "a", src: f("testsrc.mp4"), in: 0, out: 2 }, { id: "b", src: f("testsrc-b.mp4"), in: 0, out: 1, startSec: 1 },
    ] }] };
    const res = await callTool(client, "render", { timeline, preset: "square", output: f("ov.mp4") });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/overlaps clip a/);
  });

  it("overlay layer honours layerStartSec / layerDurationSec", async () => {
    const layer = f("red.webm");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=2,format=yuva420p", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "200k", layer]);
    const timeline: Timeline = { width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: f("testsrc.mp4"), in: 0, out: 2 }] }] };
    const output = f("tl-layer.mp4");
    const res = await callTool<RenderResult>(client, "render", { timeline, preset: "square", output, overlay: layer, layerStartSec: 1, layerDurationSec: 0.5 });
    expect(res.isError, res.text).toBe(false);
    expect(isRed(pixelAt(output, 0.5, 540, 540))).toBe(false);
    expect(isRed(pixelAt(output, 1.2, 540, 540))).toBe(true);
    expect(isRed(pixelAt(output, 1.8, 540, 540))).toBe(false);
  });

  it("rejects input+timeline together and missing sources", async () => {
    const timeline: Timeline = { width: 2, height: 2, fps: 30, tracks: [{ id: "v", kind: "video", clips: [{ id: "x", src: f("nope.mp4"), in: 0, out: 1 }] }] };
    const both = await callTool(client, "render", { input: f("testsrc.mp4"), timeline, preset: "square", output: f("x.mp4") });
    expect(both.isError).toBe(true);
    const missing = await callTool(client, "render", { timeline, preset: "square", output: f("y.mp4") });
    expect(missing.text).toMatch(/source not found/);
  });
});
