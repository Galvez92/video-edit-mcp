import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConcatResult, CutResult, TrimResult } from "../src/core/edit.js";
import type { ProbeResult } from "../src/core/ffmpeg.js";
import { callTool, connectClient, failed, hasFfmpeg, makeFixtures, makeTempDir } from "./helpers.js";

describe.skipIf(!hasFfmpeg)("editing tools (require ffmpeg)", () => {
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

  describe("trim", () => {
    it("keeps the requested range and reports its real duration", async () => {
      const output = join(dir, "trim-mid.mp4");
      const res = await callTool<TrimResult>(client, "trim", { input: clip(), start: 0.5, end: 1.5, output });
      expect(res.isError).toBe(false);
      expect(res.data.mode).toBe("reencode");
      expect(res.data.durationSec).toBeGreaterThan(0.9);
      expect(res.data.durationSec).toBeLessThan(1.1);

      const probed = await callTool<ProbeResult>(client, "probe", { path: output });
      expect(probed.data.durationSec).toBeGreaterThan(0.9);
      expect(probed.data.durationSec).toBeLessThan(1.1);
    });

    it("stream-copies a range that starts on a keyframe", async () => {
      const res = await callTool<TrimResult>(client, "trim", {
        input: clip(),
        start: 0,
        end: 1,
        output: join(dir, "trim-head.mp4"),
      });
      expect(res.isError).toBe(false);
      expect(res.data.mode).toBe("copy");
      // A stream copy cuts on packet boundaries, so it is exact to the keyframe, not to the frame.
      expect(res.data.durationSec).toBeGreaterThan(0.9);
      expect(res.data.durationSec).toBeLessThan(1.25);
    });

    it("rejects invalid ranges", async () => {
      const empty = await callTool(client, "trim", { input: clip(), start: 1, end: 1, output: join(dir, "x.mp4") });
      expect(empty.isError).toBe(true);
      expect(empty.text).toMatch(/end must be greater than start/);

      const past = await callTool(client, "trim", { input: clip(), start: 5, end: 6, output: join(dir, "x.mp4") });
      expect(past.isError).toBe(true);
      expect(past.text).toMatch(/past the end of the input/);
    });

    it("never overwrites an existing output unless asked", async () => {
      const output = join(dir, "trim-guard.mp4");
      writeFileSync(output, "sentinel");
      const kept = await callTool(client, "trim", { input: clip(), start: 0, end: 1, output });
      expect(kept.isError).toBe(true);
      expect(kept.text).toMatch(/output already exists/);
      expect(readFileSync(output, "utf8")).toBe("sentinel");

      const forced = await callTool<TrimResult>(client, "trim", { input: clip(), start: 0, end: 1, output, overwrite: true });
      expect(forced.isError).toBe(false);
      expect(readFileSync(output, "utf8")).not.toBe("sentinel");
    });
  });

  describe("cut", () => {
    it("keeps the listed segments and joins them", async () => {
      const output = join(dir, "cut-multi.mp4");
      const res = await callTool<CutResult>(client, "cut", {
        input: clip(),
        segments: [
          { start: 0, end: 0.5 },
          { start: 1.2, end: 1.6 },
        ],
        output,
      });
      expect(res.isError).toBe(false);
      expect(res.data.segments).toBe(2);
      expect(res.data.durationSec).toBeGreaterThan(0.75);
      expect(res.data.durationSec).toBeLessThan(1.05);

      const probed = await callTool<ProbeResult>(client, "probe", { path: output });
      expect(probed.data.streams.map((s) => s.type)).toEqual(["video", "audio"]);
    });

    it("handles a video-only input", async () => {
      const output = join(dir, "cut-silent.mp4");
      const res = await callTool<CutResult>(client, "cut", {
        input: join(dir, "silent.mp4"),
        segments: [
          { start: 0, end: 0.4 },
          { start: 0.6, end: 0.9 },
        ],
        output,
      });
      expect(res.isError).toBe(false);
      expect(res.data.durationSec).toBeGreaterThan(0.55);
      expect(res.data.durationSec).toBeLessThan(0.85);

      const probed = await callTool<ProbeResult>(client, "probe", { path: output });
      expect(probed.data.streams.map((s) => s.type)).toEqual(["video"]);
    });

    it("rejects invalid segments", async () => {
      const backwards = await callTool(client, "cut", {
        input: clip(),
        segments: [{ start: 1, end: 0.5 }],
        output: join(dir, "x.mp4"),
      });
      expect(backwards.isError).toBe(true);
      expect(backwards.text).toMatch(/segment 0: end must be greater than start/);

      const past = await callTool(client, "cut", {
        input: clip(),
        segments: [{ start: 3, end: 3.5 }],
        output: join(dir, "x.mp4"),
      });
      expect(past.isError).toBe(true);
      expect(past.text).toMatch(/segment 0: start .* is past the end of the input/);

      const none = await failed(callTool(client, "cut", { input: clip(), segments: [], output: join(dir, "x.mp4") }));
      expect(none).toBe(true);
    });
  });

  describe("concat", () => {
    it("normalizes inputs with different size, frame rate and sample rate", async () => {
      const output = join(dir, "concat-normalized.mp4");
      const res = await callTool<ConcatResult>(client, "concat", {
        inputs: [clip(), join(dir, "testsrc-wide.mp4")],
        output,
      });
      expect(res.isError).toBe(false);
      expect(res.data.normalized).toBe(true);
      expect(res.data.durationSec).toBeGreaterThan(2.7);
      expect(res.data.durationSec).toBeLessThan(3.3);

      const probed = await callTool<ProbeResult>(client, "probe", { path: output });
      const video = probed.data.streams.find((s) => s.type === "video");
      const audio = probed.data.streams.find((s) => s.type === "audio");
      expect(video).toMatchObject({ width: 640, height: 360, fps: 30 });
      expect(audio).toMatchObject({ sampleRate: 48000 });
    });

    it("stream-copies compatible inputs when normalization is off", async () => {
      const output = join(dir, "concat-copy.mp4");
      const res = await callTool<ConcatResult>(client, "concat", {
        inputs: [clip(), join(dir, "testsrc-b.mp4")],
        output,
        normalize: false,
      });
      expect(res.isError).toBe(false);
      expect(res.data.normalized).toBe(false);
      expect(res.data.durationSec).toBeGreaterThan(2.6);
      expect(res.data.durationSec).toBeLessThan(3.4);
    });

    it("rejects a mix of layouts it cannot normalize", async () => {
      const res = await callTool(client, "concat", {
        inputs: [clip(), join(dir, "silent.mp4")],
        output: join(dir, "x.mp4"),
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/mix files with and without an audio stream/);

      const single = await failed(callTool(client, "concat", { inputs: [clip()], output: join(dir, "x.mp4") }));
      expect(single).toBe(true);
    });
  });

  it("reports progress while running ffmpeg", async () => {
    const updates: number[] = [];
    const res = await client.callTool(
      { name: "trim", arguments: { input: clip(), start: 0, end: 1, output: join(dir, "trim-progress.mp4") } },
      undefined,
      { onprogress: (p: { progress: number }) => updates.push(p.progress) },
    );
    expect(res.isError).toBeFalsy();
    expect(updates.length).toBeGreaterThan(0);
    // ffmpeg reports the time of the frame it just wrote, which may overshoot the last one slightly.
    expect(Math.max(...updates)).toBeGreaterThan(0.5);
    expect(Math.max(...updates)).toBeLessThan(1.2);
  });
});
