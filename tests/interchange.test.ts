import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, connectClient } from "./helpers.js";

interface Imported {
  width: number;
  height: number;
  fps: number;
  tracks: { id: string; kind: string; clips: { id: string; src: string; in: number; out: number; startSec?: number }[] }[];
  warnings: string[];
}

const EDL = `TITLE: demo edit
FCM: NON-DROP FRAME

001  TAPE1    V     C        00:00:00:00 00:00:02:00 00:00:00:00 00:00:02:00
002  TAPE1    V     C        00:00:04:00 00:00:06:00 00:00:03:00 00:00:05:00
003  MUSIC    A     C        00:00:00:00 00:00:05:00 00:00:00:00 00:00:05:00
`;

const otio = () => ({
  OTIO_SCHEMA: "Timeline.1",
  name: "demo",
  global_start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    children: [
      {
        OTIO_SCHEMA: "Track.1",
        kind: "Video",
        name: "V1",
        children: [
          {
            OTIO_SCHEMA: "Clip.2",
            name: "shot1",
            source_range: {
              OTIO_SCHEMA: "TimeRange.1",
              start_time: { OTIO_SCHEMA: "RationalTime.1", value: 24, rate: 24 },
              duration: { OTIO_SCHEMA: "RationalTime.1", value: 48, rate: 24 },
            },
            media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: "file:///media/talk.mp4" } },
          },
          {
            OTIO_SCHEMA: "Gap.1",
            source_range: {
              OTIO_SCHEMA: "TimeRange.1",
              start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
              duration: { OTIO_SCHEMA: "RationalTime.1", value: 24, rate: 24 },
            },
          },
          {
            OTIO_SCHEMA: "Clip.2",
            name: "shot2",
            source_range: {
              OTIO_SCHEMA: "TimeRange.1",
              start_time: { OTIO_SCHEMA: "RationalTime.1", value: 120, rate: 24 },
              duration: { OTIO_SCHEMA: "RationalTime.1", value: 24, rate: 24 },
            },
            media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: "file:///media/talk.mp4" } },
          },
        ],
      },
      {
        OTIO_SCHEMA: "Track.1",
        kind: "Audio",
        name: "A1",
        children: [
          {
            OTIO_SCHEMA: "Clip.1",
            name: "music",
            source_range: {
              OTIO_SCHEMA: "TimeRange.1",
              start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
              duration: { OTIO_SCHEMA: "RationalTime.1", value: 96, rate: 24 },
            },
            media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: "file:///media/music.wav" },
          },
        ],
      },
    ],
  },
});

describe("interchange import", () => {
  let dir = "";
  const write = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-interchange-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("imports a CMX3600 EDL into video + audio tracks at their record positions", async () => {
    const client = await connectClient();
    const call = await callTool<Imported>(client, "import.edl", {
      path: write("demo.edl", EDL),
      mediaMap: { TAPE1: "/media/talk.mp4" },
    });
    expect(call.isError).toBe(false);
    expect(call.data.fps).toBe(25);
    expect(call.data.tracks.map((t) => `${t.id}/${t.kind}`)).toEqual(["v1/video", "a1/audio"]);

    const video = call.data.tracks[0].clips;
    expect(video).toHaveLength(2);
    expect(video[0]).toMatchObject({ src: "/media/talk.mp4", in: 0, out: 2, startSec: 0 });
    // second event records at 00:00:03:00 → a one-second gap after the first clip
    expect(video[1]).toMatchObject({ in: 4, out: 6, startSec: 3 });
    expect(call.data.tracks[1].clips[0]).toMatchObject({ src: "MUSIC", in: 0, out: 5 });

    // a reel without a mediaMap entry still imports, and says so
    expect(call.data.warnings.join(" ")).toContain('reel "MUSIC" is not in mediaMap');
    await client.close();
  });

  it("reports the line number for a malformed EDL", async () => {
    const client = await connectClient();
    const broken = EDL.replace("00:00:05:00", "00:00:XX:00");
    const call = await callTool(client, "import.edl", { path: write("broken.edl", broken) });
    expect(call.isError).toBe(true);
    expect(call.text).toContain("EDL line 5");
    expect(call.text).toContain("invalid timecode");
    await client.close();
  });

  it("returns isError for a missing EDL", async () => {
    const client = await connectClient();
    const call = await callTool(client, "import.edl", { path: join(dir, "nope.edl") });
    expect(call.isError).toBe(true);
    expect(call.text).toContain("file not found");
    await client.close();
  });

  it("imports OpenTimelineIO clips and gaps onto their tracks", async () => {
    const client = await connectClient();
    const call = await callTool<Imported>(client, "import.otio", { path: write("demo.otio", JSON.stringify(otio())) });
    expect(call.isError).toBe(false);
    expect(call.data.fps).toBe(24);
    expect(call.data.tracks.map((t) => `${t.id}/${t.kind}`)).toEqual(["v1/video", "a1/audio"]);

    const video = call.data.tracks[0].clips;
    expect(video).toHaveLength(2);
    expect(video[0]).toMatchObject({ src: "/media/talk.mp4", in: 1, out: 3, startSec: 0 });
    // the 1s gap pushes the second clip to 00:00:03
    expect(video[1]).toMatchObject({ in: 5, out: 6, startSec: 3 });
    expect(call.data.tracks[1].clips[0]).toMatchObject({ src: "/media/music.wav", in: 0, out: 4 });
    await client.close();
  });

  it("reports isError for invalid OTIO JSON and for a stack without clips", async () => {
    const client = await connectClient();
    const invalid = await callTool(client, "import.otio", { path: write("bad.otio", "{ not json") });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("invalid JSON");

    const empty = await callTool(client, "import.otio", {
      path: write("empty.otio", JSON.stringify({ OTIO_SCHEMA: "Timeline.1", tracks: { OTIO_SCHEMA: "Stack.1", children: [] } })),
    });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("tracks stack is empty");
    await client.close();
  });
});
