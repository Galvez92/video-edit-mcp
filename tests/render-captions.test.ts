import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCues, parseVtt } from "../src/core/caption-source.js";
import type { PackageResult, RenderResult } from "../src/core/render.js";
import { callTool, connectClient, hasFfmpeg, hyperframesReady, makeTempDir } from "./helpers.js";

const VTT = "WEBVTT\n\nNOTE demo\n\nintro\n00:00.200 --> 00:01.000 align:center\nHello there\n\n00:01.100 --> 00:01.900\nSecond line\nwraps\n";
const SRT = "1\n00:00:00,100 --> 00:00:01,800\nBURNED CAPTION\n";

describe("caption sources", () => {
  it("parses WebVTT (ids, settings, NOTE blocks)", () => {
    expect(parseVtt(VTT)).toEqual([
      { start: 0.2, end: 1, lines: ["Hello there"] },
      { start: 1.1, end: 1.9, lines: ["Second line", "wraps"] },
    ]);
    expect(() => parseVtt("1\n00:00:01,000 --> 00:00:02,000\nx\n")).toThrow(/WEBVTT header/);
  });

  it("accepts inline cues and the transcribe output object", async () => {
    expect(await loadCues({ cues: [{ start: 0, end: 1, text: "a\nb" }] })).toEqual([{ start: 0, end: 1, lines: ["a", "b"] }]);
    const cues = await loadCues({ transcript: { segments: [{ start: 0, end: 1.5, text: "from transcribe" }] } });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.lines.join(" ")).toBe("from transcribe");
  });

  it("rejects zero or several sources and bad cues", async () => {
    await expect(loadCues({})).rejects.toThrow(/provide transcript segments or an srt file path/);
    await expect(loadCues({ srt: "a.srt", cues: [] })).rejects.toThrow(/not both/);
    await expect(loadCues({ cues: [{ start: 1, end: 1, text: "x" }] })).rejects.toThrow(/end must be after start/);
    await expect(loadCues({ cues: [{ start: 0, end: 1 }] })).rejects.toThrow(/no text/);
  });
});

/** Peak luma of the lower third of a frame at `t` s (black program: high only where text is drawn). */
const ymaxOf = (file: string, t: number): number => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "crop=iw:ih/3:0:ih*2/3,signalstats,metadata=print:key=lavfi.signalstats.YMAX", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/YMAX=(\d+)/.exec(r.stderr + r.stdout)?.[1] ?? -1);
};

describe.skipIf(!hasFfmpeg)("render with captions (requires ffmpeg)", () => {
  let dir = "";
  let client: Client;
  let black = "";
  let srt = "";
  const timeline = () => ({
    width: 1080, height: 1920, fps: 30,
    tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: black, in: 0, out: 1 }, { id: "b", src: black, in: 0, out: 1, transition: { type: "crossfade", durationSec: 0.2 } }] }],
  });

  beforeAll(async () => {
    dir = makeTempDir();
    black = join(dir, "black.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", black]);
    srt = join(dir, "in.srt");
    writeFileSync(srt, SRT);
    client = await connectClient();
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("burns SRT captions into a timeline render (ffmpeg engine), writes the sidecar SRT, and export.package ships it", async () => {
    const output = join(dir, "cap.mp4");
    const res = await callTool<RenderResult>(client, "render", {
      timeline: timeline(), preset: "vertical-9x16", output, captions: { srt, style: "box", engine: "ffmpeg" },
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.data).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac", captions: { engine: "ffmpeg", cues: 1, style: "box", srt: join(dir, "cap.srt") } });
    expect(res.data.durationSec).toBeGreaterThan(1.7);
    expect(res.data.durationSec).toBeLessThan(1.95);
    expect(readFileSync(join(dir, "cap.srt"), "utf8")).toContain("BURNED CAPTION");

    const plain = join(dir, "plain.mp4");
    expect((await callTool(client, "render", { timeline: timeline(), preset: "vertical-9x16", output: plain })).isError).toBe(false);
    expect(ymaxOf(plain, 1)).toBeLessThan(60);
    expect(ymaxOf(output, 1)).toBeGreaterThan(150);

    const zip = join(dir, "pkg.zip");
    const pkg = await callTool<PackageResult>(client, "export.package", { video: output, output: zip });
    expect(pkg.isError, pkg.text).toBe(false);
    expect(pkg.data.entries).toContain("captions.srt");
    expect(execFileSync("unzip", ["-p", zip, "captions.srt"]).toString()).toContain("BURNED CAPTION");
    const noSide = await callTool<PackageResult>(client, "export.package", { video: output, output: join(dir, "pkg2.zip"), sidecarCaptions: false });
    expect(noSide.data.entries).not.toContain("captions.srt");
  }, 180_000);

  it("auto engine picks HyperFrames when available, else falls back to ffmpeg with a warning; custom srtOutput", async () => {
    const output = join(dir, "auto.mp4");
    const srtOutput = join(dir, "sub", "..", "auto-captions.srt");
    const res = await callTool<RenderResult>(client, "render", {
      input: black, preset: "vertical-9x16", output, captions: { cues: [{ start: 0.2, end: 1.6, text: "AUTO ENGINE" }], srtOutput },
    });
    expect(res.isError, res.text).toBe(false);
    const ready = await hyperframesReady();
    expect(res.data.captions?.engine).toBe(ready ? "hyperframes" : "ffmpeg");
    if (!ready) expect(res.data.warnings.join(" ")).toMatch(/fallback/);
    expect(existsSync(srtOutput)).toBe(true);
    expect(ymaxOf(output, 1)).toBeGreaterThan(150);
  }, 300_000);

  it("rejects captions on audio-only, existing sidecar without overwrite, and an unknown srt", async () => {
    const audio = await callTool(client, "render", { input: black, preset: "audio-only", output: join(dir, "a.m4a"), captions: { srt } });
    expect(audio.isError).toBe(true);
    expect(audio.text).toMatch(/video preset/);
    writeFileSync(join(dir, "taken.srt"), "x");
    const taken = await callTool(client, "render", { input: black, preset: "square", output: join(dir, "taken.mp4"), captions: { srt } });
    expect(taken.isError).toBe(true);
    expect(taken.text).toMatch(/taken\.srt/);
    const missing = await callTool(client, "render", { input: black, preset: "square", output: join(dir, "m.mp4"), captions: { srt: join(dir, "nope.srt") } });
    expect(missing.isError).toBe(true);
  }, 60_000);
});
