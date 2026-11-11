import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probe } from "../src/core/ffmpeg.js";
import { connectClient, hasFfmpeg, toolJson, toolText, type ToolResult } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.srt", import.meta.url));

describe.skipIf(!hasFfmpeg)("captions.render (requires ffmpeg)", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-captions-burn-"));
    execFileSync("bash", ["scripts/make-fixtures.sh", dir]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("burns an SRT fixture in with the ffmpeg engine and keeps the source audio", async () => {
    const client = await connectClient();
    const input = join(dir, "testsrc.mp4");
    const output = join(dir, "captioned-srt.mp4");

    const result = await client.callTool({
      name: "captions.render",
      arguments: { input, output, srt: fixture, engine: "ffmpeg", style: "box" },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    expect(toolJson(result)).toMatchObject({
      output,
      engine: "ffmpeg",
      cues: 3,
      width: 320,
      height: 240,
      fps: 25,
    });

    const probed = await probe(output);
    expect(probed.durationSec).toBeGreaterThan(1.85);
    expect(probed.durationSec).toBeLessThan(2.15);
    const video = probed.streams.find((stream) => stream.type === "video");
    const audio = probed.streams.find((stream) => stream.type === "audio");
    expect(video).toMatchObject({ codec: "h264", width: 320, height: 240 });
    expect(audio).toMatchObject({ codec: "aac", sampleRate: 48000 });

    const again = await client.callTool({
      name: "captions.render",
      arguments: { input, output, srt: fixture, engine: "ffmpeg" },
    });
    expect((again as ToolResult).isError).toBe(true);
    expect(toolText(again)).toMatch(/already exists/);
    await client.close();
  }, 120_000);

  it("burns transcription segments in with the ffmpeg engine", async () => {
    const client = await connectClient();
    const output = join(dir, "captioned-segments.mp4");

    const result = await client.callTool({
      name: "captions.render",
      arguments: {
        input: join(dir, "testsrc.mp4"),
        output,
        engine: "ffmpeg",
        style: "karaoke",
        transcript: [
          { start: 0.2, end: 1.6, text: "words appear one after another" },
        ],
      },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    expect(toolJson(result)).toMatchObject({ output, engine: "ffmpeg", cues: 1 });

    const probed = await probe(output);
    expect(probed.durationSec).toBeGreaterThan(1.85);
    expect(probed.streams.some((stream) => stream.type === "audio")).toBe(true);
    await client.close();
  }, 120_000);

  it("reports errors for a missing input or an input without video", async () => {
    const client = await connectClient();
    const missing = await client.callTool({
      name: "captions.render",
      arguments: {
        input: join(dir, "nope.mp4"),
        output: join(dir, "nope-out.mp4"),
        srt: fixture,
        engine: "ffmpeg",
      },
    });
    expect((missing as ToolResult).isError).toBe(true);

    const audioOnly = await client.callTool({
      name: "captions.render",
      arguments: {
        input: join(dir, "tone.wav"),
        output: join(dir, "tone-out.mp4"),
        srt: fixture,
        engine: "ffmpeg",
      },
    });
    expect((audioOnly as ToolResult).isError).toBe(true);
    expect(toolText(audioOnly)).toMatch(/no video stream/);
    await client.close();
  }, 120_000);
});
