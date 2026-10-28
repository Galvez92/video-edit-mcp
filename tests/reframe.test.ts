import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probe } from "../src/core/ffmpeg.js";
import { connectClient, hasFfmpeg, toolJson, toolText, type ToolResult } from "./helpers.js";

describe.skipIf(!hasFfmpeg)("reframe (requires ffmpeg)", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-reframe-"));
    execFileSync("bash", ["scripts/make-fixtures.sh", dir]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const video = (name: string) => probe(join(dir, name));

  it("crops 320x240 to a 9:16 portrait with even, near-9:16 dimensions", async () => {
    const client = await connectClient();
    const output = join(dir, "crop-9-16.mp4");
    const result = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output, aspect: "9:16" },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    expect(toolJson(result)).toMatchObject({ aspect: "9:16", mode: "crop", width: 136, height: 240, follow: false });

    const info = await video("crop-9-16.mp4");
    const v = info.streams.find((s) => s.type === "video")!;
    const w = v.width ?? 0;
    const h = v.height ?? 0;
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
    // ratio within 1px of 9:16
    expect(Math.abs(w - (h * 9) / 16)).toBeLessThanOrEqual(1);
    expect(v).toMatchObject({ codec: "h264" });
    expect(info.streams.some((s) => s.type === "audio")).toBe(true);
    await client.close();
  }, 120_000);

  it("crops to 1:1, 16:9 and 4:5 with the right crop windows", async () => {
    const client = await connectClient();
    const cases: Array<{ aspect: "1:1" | "16:9" | "4:5"; w: number; h: number }> = [
      { aspect: "1:1", w: 240, h: 240 },
      { aspect: "16:9", w: 320, h: 180 },
      { aspect: "4:5", w: 192, h: 240 },
    ];
    for (const c of cases) {
      const output = join(dir, `crop-${c.aspect.replace(":", "x")}.mp4`);
      const result = await client.callTool({
        name: "reframe",
        arguments: { input: join(dir, "testsrc.mp4"), output, aspect: c.aspect },
      });
      expect((result as ToolResult).isError).toBeFalsy();
      expect(toolJson(result)).toMatchObject({ width: c.w, height: c.h });
      const info = await video(`crop-${c.aspect.replace(":", "x")}.mp4`);
      const v = info.streams.find((s) => s.type === "video")!;
      expect(v).toMatchObject({ width: c.w, height: c.h });
      expect((v.width ?? 0) % 2).toBe(0);
      expect((v.height ?? 0) % 2).toBe(0);
    }
    await client.close();
  }, 120_000);

  it("scales a crop to a requested output height", async () => {
    const client = await connectClient();
    const output = join(dir, "crop-9-16-1080.mp4");
    const result = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output, aspect: "9:16", height: 1080 },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    expect(toolJson(result)).toMatchObject({ width: 608, height: 1080 });
    await client.close();
  }, 120_000);

  it("pads to 9:16 keeping the full frame (no crop)", async () => {
    const client = await connectClient();
    const output = join(dir, "pad-9-16.mp4");
    const result = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output, aspect: "9:16", mode: "pad", padColor: "0x0000ff" },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    const info = await video("pad-9-16.mp4");
    const v = info.streams.find((s) => s.type === "video")!;
    expect(v).toMatchObject({ width: 136, height: 240 });
    expect(info.streams.some((s) => s.type === "audio")).toBe(true);
    await client.close();
  }, 120_000);

  it("blur-pads to 9:16 with correct dimensions", async () => {
    const client = await connectClient();
    const output = join(dir, "blurpad-9-16.mp4");
    const result = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output, aspect: "9:16", mode: "blur-pad" },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    expect(toolJson(result)).toMatchObject({ mode: "blur-pad", width: 136, height: 240 });
    const info = await video("blurpad-9-16.mp4");
    expect(info.streams.find((s) => s.type === "video")!).toMatchObject({ width: 136, height: 240 });
    await client.close();
  }, 120_000);

  it("reports errors for missing input, no video, an existing output and bad aspect", async () => {
    const client = await connectClient();

    const missing = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "nope.mp4"), output: join(dir, "nope-out.mp4"), aspect: "9:16" },
    });
    expect((missing as ToolResult).isError).toBe(true);

    const noVideo = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "tone.wav"), output: join(dir, "tone-out.mp4"), aspect: "9:16" },
    });
    expect((noVideo as ToolResult).isError).toBe(true);
    expect(toolText(noVideo)).toMatch(/no video stream/);

    const exists = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output: join(dir, "crop-9-16.mp4"), aspect: "9:16" },
    });
    expect((exists as ToolResult).isError).toBe(true);
    expect(toolText(exists)).toMatch(/already exists/);

    const badAspect = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output: join(dir, "bad.mp4"), aspect: "7:3" },
    });
    expect((badAspect as ToolResult).isError).toBe(true);

    await client.close();
  }, 120_000);

  it("rejects follow outside crop mode, and reports follow as unavailable with no detector", async () => {
    const client = await connectClient();

    const followPad = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output: join(dir, "follow-pad.mp4"), aspect: "9:16", mode: "pad", follow: true },
    });
    expect((followPad as ToolResult).isError).toBe(true);
    expect(toolText(followPad)).toMatch(/only supported in "crop" mode/);

    const previous = process.env.REFRAME_FACE_MODULE;
    delete process.env.REFRAME_FACE_MODULE;
    const followUnavailable = await client.callTool({
      name: "reframe",
      arguments: { input: join(dir, "testsrc.mp4"), output: join(dir, "follow.mp4"), aspect: "9:16", follow: true },
    });
    expect((followUnavailable as ToolResult).isError).toBe(true);
    expect(toolText(followUnavailable)).toMatch(/unavailable/);
    if (previous !== undefined) process.env.REFRAME_FACE_MODULE = previous;
    await client.close();
  }, 120_000);
});

if (!hasFfmpeg) console.warn("ffmpeg not found: reframe tests skipped");
