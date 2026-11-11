import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProducer } from "../src/core/hyperframes.js";
import { connectClient, toolJson, toolText, type ToolResult } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.srt", import.meta.url));
const producerAvailable = (await loadProducer()) !== null;

describe("captions.generate", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-captions-tool-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes SRT from the fixture", async () => {
    const client = await connectClient();
    const output = join(dir, "from-fixture.srt");
    const result = await client.callTool({ name: "captions.generate", arguments: { srt: fixture, format: "srt", output } });
    expect((result as ToolResult).isError).toBeFalsy();
    expect(toolJson(result)).toMatchObject({ format: "srt", cues: 3 });
    expect(readFileSync(output, "utf8")).toBe(readFileSync(fixture, "utf8"));
    await client.close();
  });

  it("writes ASS from transcription segments", async () => {
    const client = await connectClient();
    const output = join(dir, "from-segments.ass");
    const result = await client.callTool({
      name: "captions.generate",
      arguments: {
        transcript: [
          { start: 0, end: 2, text: "an animated caption example for the fixture" },
          { start: 2, end: 4, text: "with a second segment that wraps too" },
        ],
        format: "ass",
        output,
        style: "karaoke",
        width: 1280,
        height: 720,
      },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    const ass = readFileSync(output, "utf8");
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1280");
    expect(ass).toContain("[Events]");
    expect(ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length).toBeGreaterThanOrEqual(2);
    await client.close();
  });

  it("writes a HyperFrames composition with a timed element per chunk", async () => {
    const client = await connectClient();
    const output = join(dir, "composition.html");
    const result = await client.callTool({
      name: "captions.generate",
      arguments: { srt: fixture, format: "hyperframes", output, style: "pop", width: 1080, height: 1920 },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    expect(toolJson(result)).toMatchObject({ format: "hyperframes", style: "pop", cues: 3 });
    const html = readFileSync(output, "utf8");
    expect(html.match(/data-composition-id="captions"/g)).toHaveLength(1);
    expect(html.match(/class="hf-cue /g)).toHaveLength(3);
    expect(html).toContain('data-width="1080"');
    await client.close();
  });

  it("reads transcript segments from a JSON file and respects the line limits", async () => {
    const client = await connectClient();
    const transcriptPath = join(dir, "transcript.json");
    writeFileSync(transcriptPath, JSON.stringify({ segments: [{ start: 0, end: 1.5, text: "first chunk of speech" }] }), "utf8");
    const output = join(dir, "from-file.srt");
    const result = await client.callTool({
      name: "captions.generate",
      arguments: { transcript: transcriptPath, format: "srt", output, maxCharsPerLine: 10, maxLines: 1 },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    const srt = readFileSync(output, "utf8");
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:/);
    for (const line of srt.split("\n").filter((row) => row !== "" && !row.includes("-->"))) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
    await client.close();
  });

  it("reports errors for a missing source, both sources or an unreadable file", async () => {
    const client = await connectClient();
    const withoutSource = await client.callTool({
      name: "captions.generate",
      arguments: { format: "srt", output: join(dir, "none.srt") },
    });
    expect((withoutSource as ToolResult).isError).toBe(true);
    expect(toolText(withoutSource)).toMatch(/provide transcript segments or an srt file path/);

    const both = await client.callTool({
      name: "captions.generate",
      arguments: {
        transcript: [{ start: 0, end: 1, text: "hi" }],
        srt: fixture,
        format: "srt",
        output: join(dir, "both.srt"),
      },
    });
    expect((both as ToolResult).isError).toBe(true);
    expect(toolText(both)).toMatch(/not both/);

    const broken = join(dir, "broken.srt");
    writeFileSync(broken, "1\n00:00:01,000 --> 00:00:02,000\n", "utf8");
    const noText = await client.callTool({
      name: "captions.generate",
      arguments: { srt: broken, format: "srt", output: join(dir, "broken-out.srt") },
    });
    expect((noText as ToolResult).isError).toBe(true);
    expect(toolText(noText)).toMatch(/has no text/);

    const missing = await client.callTool({
      name: "captions.generate",
      arguments: { srt: join(dir, "missing.srt"), format: "srt", output: join(dir, "missing-out.srt") },
    });
    expect((missing as ToolResult).isError).toBe(true);
    await client.close();
  });
});

describe("captions.render input validation", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-captions-render-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects conflicting or missing caption sources", async () => {
    const client = await connectClient();
    const base = { input: join(dir, "in.mp4"), output: join(dir, "out.mp4"), engine: "ffmpeg" as const };

    const both = await client.callTool({
      name: "captions.render",
      arguments: { ...base, srt: fixture, composition: join(dir, "composition.html") },
    });
    expect((both as ToolResult).isError).toBe(true);
    expect(toolText(both)).toMatch(/not both/);

    const compositionWithFfmpeg = await client.callTool({
      name: "captions.render",
      arguments: { ...base, composition: join(dir, "composition.html") },
    });
    expect((compositionWithFfmpeg as ToolResult).isError).toBe(true);
    expect(toolText(compositionWithFfmpeg)).toMatch(/needs engine "hyperframes"/);

    const noSource = await client.callTool({ name: "captions.render", arguments: base });
    expect((noSource as ToolResult).isError).toBe(true);
    expect(toolText(noSource)).toMatch(/provide transcript segments or an srt file path/);
    await client.close();
  });

  describe.skipIf(producerAvailable)("without the HyperFrames peer installed", () => {
    it("reports the HyperFrames engine as unavailable", async () => {
      const client = await connectClient();
      const result = await client.callTool({
        name: "captions.render",
        arguments: { input: join(dir, "whatever.mp4"), output: join(dir, "unavailable.mp4"), srt: fixture },
      });
      expect((result as ToolResult).isError).toBe(true);
      expect(toolText(result)).toMatch(/unavailable/);
      await client.close();
    });
  });
});

if (!producerAvailable) console.warn("@hyperframes/producer is not installed: HyperFrames rendering is unavailable");
