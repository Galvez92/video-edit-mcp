import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProbeResult } from "../src/core/ffmpeg.js";
import type { RenderResult } from "../src/core/render.js";
import type { Timeline } from "../src/core/timeline.js";
import { buildTimelineGraph } from "../src/core/timelineRender.js";
import { callTool, connectClient, hasFfmpeg, makeFixtures, makeTempDir } from "./helpers.js";

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

  it("rejects input+timeline together and missing sources", async () => {
    const timeline: Timeline = { width: 2, height: 2, fps: 30, tracks: [{ id: "v", kind: "video", clips: [{ id: "x", src: f("nope.mp4"), in: 0, out: 1 }] }] };
    const both = await callTool(client, "render", { input: f("testsrc.mp4"), timeline, preset: "square", output: f("x.mp4") });
    expect(both.isError).toBe(true);
    const missing = await callTool(client, "render", { timeline, preset: "square", output: f("y.mp4") });
    expect(missing.text).toMatch(/source not found/);
  });
});
