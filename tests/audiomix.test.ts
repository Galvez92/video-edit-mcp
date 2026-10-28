import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectClient, hasFfmpeg } from "./helpers.js";

const text = (res: unknown): string => (res as { content: { text: string }[] }).content[0].text;
const data = <T,>(res: unknown): T => JSON.parse(text(res)) as T;
const isError = (res: unknown): boolean => Boolean((res as { isError?: boolean }).isError);

describe.skipIf(!hasFfmpeg)("audio tools (requires ffmpeg)", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-audiomix-"));
    execFileSync("bash", ["scripts/make-fixtures.sh", dir]);
    // A silent video (no audio track) for the "no audio to mix" error path.
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x120:rate=25:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      join(dir, "silent.mp4"),
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("audio.measure reports finite loudness for a tone", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "audio.measure", arguments: { input: join(dir, "tone.wav") } });
    expect(isError(res)).toBe(false);
    const m = data<{ integratedLufs: number; truePeakDb: number; lra: number }>(res);
    expect(Number.isFinite(m.integratedLufs)).toBe(true);
    expect(Number.isFinite(m.truePeakDb)).toBe(true);
    expect(m.lra).toBeGreaterThanOrEqual(0);
    await client.close();
  });

  it("audio.loudnorm normalizes a tone to ~target LUFS", async () => {
    const client = await connectClient();
    const out = join(dir, "loudnormed.wav");
    const res = await client.callTool({
      name: "audio.loudnorm",
      arguments: { input: join(dir, "tone.wav"), output: out, targetLufs: -14 },
    });
    expect(isError(res)).toBe(false);
    const r = data<{ output: string; normalized: { integratedLufs: number } }>(res);
    expect(r.normalized.integratedLufs).toBeGreaterThan(-15.5);
    expect(r.normalized.integratedLufs).toBeLessThan(-12.5);
    await client.close();
  });

  it("audio.mix mixes voice + music into a single audio stream matching the video duration", async () => {
    const client = await connectClient();
    const out = join(dir, "mixed.mp4");
    const res = await client.callTool({
      name: "audio.mix",
      arguments: {
        video: join(dir, "testsrc.mp4"),
        music: join(dir, "tone.wav"),
        musicGainDb: -10,
        fadeIn: 0.2,
        fadeOut: 0.2,
        output: out,
      },
    });
    expect(isError(res)).toBe(false);
    const r = data<{ output: string; durationSec: number; audioStreams: number }>(res);
    expect(r.audioStreams).toBe(1);
    expect(r.durationSec).toBeGreaterThan(1.8);
    expect(r.durationSec).toBeLessThan(2.3);
    await client.close();
  });

  it("audio.measure returns isError for a missing file", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "audio.measure", arguments: { input: join(dir, "nope.wav") } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/input file not found/);
    await client.close();
  });

  it("audio.mix returns isError for a missing music file", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "audio.mix",
      arguments: { video: join(dir, "testsrc.mp4"), music: join(dir, "nope.wav"), output: join(dir, "x.mp4") },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/input file not found/);
    await client.close();
  });

  it("audio.mix returns isError when the video has no audio track", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "audio.mix",
      arguments: { video: join(dir, "silent.mp4"), music: join(dir, "tone.wav"), output: join(dir, "x.mp4") },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/no audio track/);
    await client.close();
  });
});

if (!hasFfmpeg) console.warn("ffmpeg not found: audio-mix tests skipped");
