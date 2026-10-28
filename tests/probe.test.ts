import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectClient, hasFfmpeg, makeFixtures, makeTempDir } from "./helpers.js";

describe.skipIf(!hasFfmpeg)("probe (requires ffmpeg)", () => {
  let dir = "";
  beforeAll(() => {
    dir = makeTempDir();
    makeFixtures(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports video + audio streams of a generated clip", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "probe", arguments: { path: join(dir, "testsrc.mp4") } });
    expect(res.isError).toBeFalsy();
    const info = JSON.parse((res.content as { text: string }[])[0].text);
    const v = info.streams.find((s: { type: string }) => s.type === "video");
    const a = info.streams.find((s: { type: string }) => s.type === "audio");
    expect(v).toMatchObject({ codec: "h264", width: 320, height: 240, fps: 25 });
    expect(a).toMatchObject({ sampleRate: 48000 });
    expect(info.durationSec).toBeGreaterThan(1.9);
    expect(info.durationSec).toBeLessThan(2.2);
    await client.close();
  });

  it("returns isError for a missing file", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "probe", arguments: { path: join(dir, "nope.mp4") } });
    expect(res.isError).toBe(true);
    await client.close();
  });
});

if (!hasFfmpeg) console.warn("ffmpeg not found: probe tests skipped");
