import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeAvailability, compose } from "../src/core/compose.js";
import type { ProbeResult } from "../src/core/ffmpeg.js";
import type { DeliverySpec, PackageResult, RenderResult } from "../src/core/render.js";
import { callTool, connectClient, hasFfmpeg, makeFixtures, makeTempDir } from "./helpers.js";

const unzipList = (zip: string) =>
  execFileSync("unzip", ["-Z1", zip]).toString().trim().split("\n");
const unzipRead = (zip: string, name: string) => execFileSync("unzip", ["-p", zip, name]);
const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"]);
    return true;
  } catch {
    return false;
  }
})();

describe("compose without HyperFrames", () => {
  it("reports unavailable when the optional peer is missing", async () => {
    const pkg = "@hyperframes/does-not-exist";
    expect((await composeAvailability(pkg)).available).toBe(false);
    await expect(compose({ composition: "x.html", output: "y.mp4" }, pkg)).rejects.toThrow(/unavailable/);
  });
});

describe.skipIf(!hasFfmpeg)("render presets and export.package (require ffmpeg)", () => {
  let dir = "";
  let client: Client;
  const clip = () => join(dir, "testsrc.mp4");

  beforeAll(async () => {
    dir = makeTempDir();
    makeFixtures(dir);
    client = await connectClient();
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cases = [
    ["web-1080p", 1920, 1080],
    ["vertical-9x16", 1080, 1920],
    ["square", 1080, 1080],
  ] as const;
  for (const [preset, w, h] of cases) {
    it(`${preset} produces ${w}x${h} h264/aac at 30 fps`, async () => {
      const output = join(dir, `${preset}.mp4`);
      const res = await callTool<RenderResult>(client, "render", { input: clip(), preset, output });
      expect(res.isError, res.text).toBe(false);
      const p = (await callTool<ProbeResult>(client, "probe", { path: output })).data;
      const v = p.streams.find((s) => s.type === "video");
      const a = p.streams.find((s) => s.type === "audio");
      expect(v).toMatchObject({ codec: "h264", width: w, height: h, fps: 30 });
      expect(a?.codec).toBe("aac");
      expect(p.durationSec).toBeGreaterThan(1.8);
    }, 60_000);
  }

  it("audio-only produces an AAC file without video", async () => {
    const output = join(dir, "audio.m4a");
    const res = await callTool<RenderResult>(client, "render", { input: clip(), preset: "audio-only", output });
    expect(res.isError, res.text).toBe(false);
    const p = (await callTool<ProbeResult>(client, "probe", { path: output })).data;
    expect(p.streams.some((s) => s.type === "video")).toBe(false);
    expect(p.streams.find((s) => s.type === "audio")?.codec).toBe("aac");
  });

  it("rejects a video preset on audio-only input and an existing output", async () => {
    expect((await callTool(client, "render", { input: join(dir, "tone.wav"), preset: "square", output: join(dir, "x.mp4") })).isError).toBe(true);
    expect((await callTool(client, "render", { input: clip(), preset: "square", output: clip() })).isError).toBe(true);
  });

  it.skipIf(!hasUnzip)("export.package writes video, captions, spec and checksums with measured values", async () => {
    const video = join(dir, "square.mp4");
    const srt = join(dir, "subs.srt");
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nHola\n");
    const output = join(dir, "pkg.zip");
    const res = await callTool<PackageResult>(client, "export.package", { video, subtitles: srt, preset: "square", output });
    expect(res.isError, res.text).toBe(false);
    expect(unzipList(output).sort()).toEqual(["captions.srt", "checksums.sha256", "spec.json", "video.mp4"]);

    const spec = JSON.parse(unzipRead(output, "spec.json").toString()) as DeliverySpec;
    expect(spec.preset).toBe("square");
    expect(spec.video).toMatchObject({ codec: "h264", width: 1080, height: 1080, fps: 30 });
    expect(spec.audio?.codec).toBe("aac");
    // Measured on a 440 Hz sine fixture: real loudness, not a constant.
    expect(spec.loudness?.integratedLufs).toBeLessThan(-5);
    expect(spec.loudness?.integratedLufs).toBeGreaterThan(-40);
    expect(spec.loudness?.truePeakDbtp).toBeLessThan(1);

    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(spec.checksums["video.mp4"]).toBe(sha(readFileSync(video)));
    const sums = unzipRead(output, "checksums.sha256").toString();
    expect(sums).toContain(`${sha(unzipRead(output, "spec.json"))}  spec.json`);
    expect(sums).toContain(`${sha(readFileSync(srt))}  captions.srt`);
  }, 60_000);

  it.skipIf(!hasUnzip)("loudness differs between differently-leveled inputs", async () => {
    const quiet = join(dir, "quiet.mp4");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", clip(), "-af", "volume=-20dB", "-c:v", "copy", quiet]);
    const a = await callTool<PackageResult>(client, "export.package", { video: clip(), output: join(dir, "a.zip") });
    const b = await callTool<PackageResult>(client, "export.package", { video: quiet, output: join(dir, "b.zip") });
    const diff = (a.data.spec.loudness?.integratedLufs ?? 0) - (b.data.spec.loudness?.integratedLufs ?? 0);
    expect(diff).toBeGreaterThan(15);
    expect(unzipList(join(dir, "a.zip"))).not.toContain("captions.srt");
  }, 60_000);

  it("package without audio omits loudness", async () => {
    const r = await callTool<PackageResult>(client, "export.package", { video: join(dir, "silent.mp4"), output: join(dir, "s.zip") });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.spec.loudness).toBeUndefined();
  });

  it("compose tool returns an unavailable error without the peer", async () => {
    const available = (await composeAvailability()).available;
    if (available) return;
    const r = await callTool(client, "compose", { composition: join(dir, "c.html"), output: join(dir, "c.mp4") });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unavailable/);
  });
});
