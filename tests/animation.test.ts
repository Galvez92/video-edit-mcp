import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderResult } from "../src/core/render.js";
import type { Timeline } from "../src/core/timeline.js";
import { buildTimelineGraph } from "../src/core/timelineRender.js";
import { callTool, connectClient, hasFfmpeg, makeTempDir, pixelAt } from "./helpers.js";

const both = { hasVideo: true, hasAudio: true };
const V = { kind: "video" as const, width: 320, height: 240, fps: 25 };
const prog: Timeline = { width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0, out: 3 }] }] };

describe("layer animation and audio curves (graph)", () => {
  it("emits alpha fades, slide expressions and frame-eval scale", () => {
    const g = buildTimelineGraph(prog, V, { "a.mp4": both }, { layers: [
      { src: "l.mov", startSec: 1, durationSec: 2, fadeInSec: 0.5, fadeOutSec: 0.25, enter: { type: "slide-left", durationSec: 0.5 } },
      { src: "m.mov", durationSec: 2, enter: { type: "scale", durationSec: 0.5 }, exit: { type: "slide-down", durationSec: 0.5 } },
    ] });
    expect(g.filterComplex).toContain("fade=t=in:st=1:d=0.5:alpha=1");
    expect(g.filterComplex).toContain("fade=t=out:st=2.75:d=0.25:alpha=1");
    expect(g.filterComplex).toContain("x='0+(W-0)*(1-clip((t-1)/0.5,0,1))'");
    expect(g.filterComplex).toMatch(/scale=w='max\(2,trunc\(320\*max\(0\.01,clip\(\(t-0\)\/0\.5,0,1\)/);
    expect(g.filterComplex).toContain("y='0+(H-0)*clip((t-1.5)/0.5,0,1)+(240-h)/2'");
  });
  it("rejects fades or motions that do not fit the layer duration", () => {
    const L = (l: object) => () => buildTimelineGraph(prog, V, { "a.mp4": both }, { layers: [{ src: "l.mov", ...l }] });
    expect(L({ durationSec: 1, fadeInSec: 0.6, fadeOutSec: 0.6 })).toThrow(/do not fit/);
    expect(L({ durationSec: 1, enter: { type: "scale", durationSec: 0.8 }, exit: { type: "slide-up", durationSec: 0.4 } })).toThrow(/do not fit/);
    expect(L({ fadeOutSec: 0.5 })).toThrow(/need durationSec/);
    expect(L({ durationSec: 1, fadeInSec: 0 })).toThrow(/fadeInSec must be > 0/);
    expect(L({ durationSec: 1, fadeInSec: 0.5, fadeOutSec: 0.5 })).not.toThrow();
  });
  it("audio curves map to afade/acrossfade curves on both sides; video xfade unchanged", () => {
    const tl: Timeline = { width: 320, height: 240, fps: 25, tracks: [
      { id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0, out: 2 }, { id: "b", src: "a.mp4", in: 0, out: 2, transition: { type: "crossfade", durationSec: 0.5, curve: "equal-power" } }] },
      { id: "m", kind: "audio", clips: [
        { id: "c", src: "a.mp4", in: 0, out: 2, audioFade: { inSec: 0.3, curve: "log" } },
        { id: "d", src: "a.mp4", in: 0, out: 2, transition: { type: "crossfade", durationSec: 0.5, curve: "s-curve" } },
      ] },
    ] };
    const g = buildTimelineGraph(tl, V, { "a.mp4": both });
    expect(g.filterComplex).toContain("acrossfade=d=0.5:c1=qsin:c2=qsin");
    expect(g.filterComplex).toContain("xfade=transition=fade:duration=0.5:offset=1.5[");
    expect(g.filterComplex).toContain("afade=t=in:d=0.3:curve=log");
    expect(g.filterComplex).toContain("afade=t=out:st=1.5:d=0.5:curve=hsin");
    expect(g.filterComplex).toContain("afade=t=in:d=0.5:curve=hsin");
    const lin = buildTimelineGraph({ ...tl, tracks: [{ ...tl.tracks[0]!, clips: tl.tracks[0]!.clips.map((c) => ({ ...c, transition: c.transition && { ...c.transition, curve: undefined } })) }] }, V, { "a.mp4": both });
    expect(lin.filterComplex).toContain("c1=tri:c2=tri");
  });
  it("rejects audio fades longer than the clip", () => {
    const tl: Timeline = { width: 320, height: 240, fps: 25, tracks: [{ id: "m", kind: "audio", clips: [{ id: "c", src: "a.mp4", in: 0, out: 1, audioFade: { inSec: 0.7, outSec: 0.7 } }] }] };
    expect(() => buildTimelineGraph(tl, { kind: "audio" }, { "a.mp4": both })).toThrow(/audioFade in\+out/);
  });
});

describe.skipIf(!hasFfmpeg)("layer animation and audio curves (render, requires ffmpeg)", () => {
  let dir = "";
  let client: Client;
  const f = (n: string) => join(dir, n);
  const gen = (name: string, lavfi: string, extra: string[] = []) => {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", lavfi, ...extra, f(name)]);
    return f(name);
  };
  const solid = (name: string, color: string, d = 3) =>
    gen(name, `color=c=${color}:s=320x240:r=25:d=${d},format=yuva420p`, ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "200k"]);
  const meanVolume = (file: string, ss: number, t: number): number => {
    const r = spawnSync("ffmpeg", ["-v", "info", "-ss", String(ss), "-t", String(t), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r);
    return m ? (m[1] === "-inf" ? -200 : Number(m[1])) : -200;
  };
  let black = "";
  beforeAll(async () => {
    dir = makeTempDir();
    black = gen("black.mp4", "color=c=black:s=320x240:r=25:d=3", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    gen("t300.wav", "sine=frequency=300:sample_rate=48000:duration=3");
    gen("t500.wav", "sine=frequency=500:sample_rate=48000:duration=3");
    client = await connectClient();
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = (): Timeline => ({ width: 320, height: 240, fps: 25, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: black, in: 0, out: 3 }] }] });

  it("alpha fade: mid-fade pixel is between transparent and full", async () => {
    const output = f("fade.mp4");
    const res = await callTool<RenderResult>(client, "render", { timeline: base(), preset: "square", output, layers: [{ overlay: solid("red.webm", "red"), durationSec: 3, fadeInSec: 1, fadeOutSec: 1 }] });
    expect(res.isError, res.text).toBe(false);
    const mid = pixelAt(output, 0.5, 540, 540)[0];
    const full = pixelAt(output, 1.5, 540, 540)[0];
    const out = pixelAt(output, 2.5, 540, 540)[0];
    expect(full).toBeGreaterThan(220);
    expect(mid).toBeGreaterThan(50);
    expect(mid).toBeLessThan(full - 50);
    expect(out).toBeGreaterThan(50);
    expect(out).toBeLessThan(full - 50);
  });

  it("slide-left enter moves the layer across the frame over time", async () => {
    const output = f("slide.mp4");
    const res = await callTool<RenderResult>(client, "render", { timeline: base(), preset: "square", output, layers: [{ overlay: solid("blue.webm", "blue"), durationSec: 3, scale: 0.5, enter: { type: "slide-left", durationSec: 1 } }] });
    expect(res.isError, res.text).toBe(false);
    const blue = (t: number, x: number) => pixelAt(output, t, x, 270)[2] > 160;
    expect(blue(0.2, 270)).toBe(false); // still off to the right
    expect(blue(0.6, 810)).toBe(true); // passing through the right half
    expect(blue(1.5, 270)).toBe(true); // settled at x=0
    expect(blue(1.5, 810)).toBe(false);
  });

  it("render rejects a fade that does not fit the layer", async () => {
    const res = await callTool(client, "render", { timeline: base(), preset: "square", output: f("bad.mp4"), layers: [{ overlay: solid("g.webm", "green"), durationSec: 1, fadeInSec: 0.8, fadeOutSec: 0.8 }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/do not fit/);
  });

  it("equal-power crossfade has no dip; linear dips ~3 dB at mid-crossfade", async () => {
    const mk = (curve?: string): Timeline => ({ width: 320, height: 240, fps: 25, tracks: [{ id: "m", kind: "audio", clips: [
      { id: "a", src: f("t300.wav"), in: 0, out: 3 },
      { id: "b", src: f("t500.wav"), in: 0, out: 3, transition: { type: "crossfade", durationSec: 2, ...(curve ? { curve } : {}) } as Timeline["tracks"][number]["clips"][number]["transition"] },
    ] }] });
    const lin = f("lin.m4a");
    const ep = f("ep.m4a");
    expect((await callTool(client, "render", { timeline: mk(), preset: "audio-only", output: lin })).isError).toBe(false);
    expect((await callTool(client, "render", { timeline: mk("equal-power"), preset: "audio-only", output: ep })).isError).toBe(false);
    // Crossfade spans 1s..3s; mid at 2s.
    const steady = meanVolume(ep, 0.2, 0.5);
    const linMid = meanVolume(lin, 1.9, 0.2);
    const epMid = meanVolume(ep, 1.9, 0.2);
    expect(epMid - linMid).toBeGreaterThan(2);
    expect(Math.abs(epMid - steady)).toBeLessThan(1);
    expect(steady - linMid).toBeGreaterThan(2);
  });
});
