import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderResult } from "../src/core/render.js";
import type { Timeline } from "../src/core/timeline.js";
import { buildTimelineGraph, layoutLayer } from "../src/core/timelineRender.js";
import { callTool, connectClient, hasFfmpeg, makeFixtures, makeTempDir } from "./helpers.js";

const badge = { src: "b.webm", srcWidth: 360, srcHeight: 120 };

describe("layoutLayer", () => {
  it("scale is a fraction of the frame width and keeps the source aspect", () => {
    const l = layoutLayer({ ...badge, scale: 0.33, x: 680, y: 1700 }, 1080, 1920);
    expect([l.w, l.h, l.x, l.y]).toEqual([356, 118, 680, 1700]);
    expect(l.warnings).toEqual([]);
  });
  it("native scale uses the source pixel size", () => {
    const l = layoutLayer({ ...badge, scale: 0.5, scaleMode: "native" }, 1080, 1920);
    expect([l.w, l.h]).toEqual([180, 60]);
  });
  it("width only / height only keep aspect; both = explicit box (contain by default)", () => {
    expect(layoutLayer({ ...badge, width: 540 }, 1080, 1920)).toMatchObject({ w: 540, h: 180 });
    expect(layoutLayer({ ...badge, height: 300 }, 1080, 1920)).toMatchObject({ w: 900, h: 300 });
    expect(layoutLayer({ ...badge, width: 400, height: 400, x: 100, y: 100 }, 1080, 1920)).toMatchObject({ w: 400, h: 134, x: 100, y: 233, crop: false });
    expect(layoutLayer({ ...badge, width: 400, height: 400, fit: "stretch" }, 1080, 1920)).toMatchObject({ w: 400, h: 400, crop: false });
  });
  it("contain centres inside the box, cover crops to it", () => {
    expect(layoutLayer({ ...badge, width: 400, height: 400, fit: "contain", x: 100, y: 100 }, 1080, 1920)).toMatchObject({ w: 400, h: 134, x: 100, y: 233 });
    expect(layoutLayer({ ...badge, width: 400, height: 400, fit: "cover" }, 1080, 1920)).toMatchObject({ sw: 1200, sh: 400, w: 400, h: 400, crop: true });
  });
  it("no size fills the frame as before", () => {
    expect(layoutLayer({ src: "f.webm", srcWidth: 320, srcHeight: 240 }, 1080, 1920)).toMatchObject({ w: 1080, h: 1920, x: 0, y: 0 });
    expect(layoutLayer({ src: "f.webm" }, 320, 240)).toMatchObject({ w: 320, h: 240 });
  });
  it("clamps an off-frame layer into the frame and warns", () => {
    const l = layoutLayer({ ...badge, scale: 0.33, x: 900, y: 1900 }, 1080, 1920, "layer 1");
    expect([l.x, l.y]).toEqual([1080 - 356, 1920 - 118]);
    expect(l.warnings[0]).toMatch(/layer 1: 356x118 at \(900,1900\) extends off the 1080x1920 frame; position clamped to \(724,1802\)/);
  });
  it("graph uses the computed size and returns warnings; validates new fields", () => {
    const tl: Timeline = { width: 1080, height: 1920, fps: 30, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0, out: 1 }] }] };
    const V = { kind: "video" as const, width: 1080, height: 1920, fps: 30 };
    const src = { "a.mp4": { hasVideo: true, hasAudio: true } };
    const g = buildTimelineGraph(tl, V, src, { layers: [{ ...badge, scale: 0.33, x: 2000, y: 0 }] });
    expect(g.filterComplex).toContain("scale=356:118");
    expect(g.filterComplex).toContain("overlay=724:0");
    expect(g.warnings).toHaveLength(1);
    expect(() => buildTimelineGraph(tl, V, src, { layers: [{ ...badge, scale: 0.5, width: 100 }] })).toThrow(/not both/);
    expect(() => buildTimelineGraph(tl, V, src, { layers: [{ ...badge, scale: 3, scaleMode: "native" }] })).not.toThrow();
  });
});

/** Bounding box of pixels matching `pred` in the frame at `t`. */
function bbox(file: string, t: number, W: number, H: number, pred: (r: number, g: number, b: number) => boolean) {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (pred(buf[i]!, buf[i + 1]!, buf[i + 2]!)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe.skipIf(!hasFfmpeg)("layer layout renders (requires ffmpeg)", () => {
  let dir = "";
  let client: Client;
  const f = (n: string) => join(dir, n);
  beforeAll(async () => {
    dir = makeTempDir();
    makeFixtures(dir);
    client = await connectClient();
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // Black program so a magenta layer is easy to find.
  const program = (): Timeline => {
    const p = f("black.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
    return { width: 1080, height: 1920, fps: 30, tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: p, in: 0, out: 1 }] }] };
  };
  const solid = (name: string, size: string) => {
    const p = f(name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=magenta:s=${size}:r=30:d=1,format=yuva420p`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "500k", p]);
    return p;
  };
  const magenta = (r: number, g: number, b: number) => r > 150 && b > 150 && g < 100;
  const render = (output: string, layers: object[]) => callTool<RenderResult>(client, "render", { timeline: program(), preset: "vertical-9x16", output, layers });

  it("360x120 badge at scale 0.33 keeps 3:1, stays in frame; result carries probe info", async () => {
    const out = f("badge.mp4");
    const res = await render(out, [{ overlay: solid("badge.webm", "360x120"), x: 680, y: 1700, scale: 0.33 }]);
    expect(res.isError, res.text).toBe(false);
    const b = bbox(out, 0.5, 1080, 1920, magenta);
    expect(b.w / b.h).toBeCloseTo(3, 0);
    expect(Math.abs(b.w - 356)).toBeLessThanOrEqual(4);
    expect(b.y + b.h).toBeLessThanOrEqual(1920);
    expect(res.data).toMatchObject({ width: 1080, height: 1920, fps: 30, videoCodec: "h264", warnings: [] });
    expect(res.data.bytes).toBeGreaterThan(0);
  });

  it("off-frame position is clamped and reported", async () => {
    const out = f("clamp.mp4");
    const res = await render(out, [{ overlay: solid("badge2.webm", "360x120"), x: 1000, y: 1900, scale: 0.33 }]);
    expect(res.isError, res.text).toBe(false);
    expect(res.data.warnings).toHaveLength(1);
    expect(res.data.warnings[0]).toMatch(/clamped to \(724,1802\)/);
    const b = bbox(out, 0.5, 1080, 1920, magenta);
    expect(b.x + b.w).toBeGreaterThanOrEqual(1076);
    expect(b.y + b.h).toBeGreaterThanOrEqual(1916);
    expect(b.w / b.h).toBeCloseTo(3, 0);
  });

  it("width-only keeps aspect; explicit stretch box is honoured; full-frame unchanged", async () => {
    const out = f("sizes.mp4");
    const res = await render(out, [{ overlay: solid("badge3.webm", "360x120"), x: 0, y: 0, width: 540 }]);
    expect(res.isError, res.text).toBe(false);
    const a = bbox(out, 0.5, 1080, 1920, magenta);
    expect(Math.abs(a.w - 540)).toBeLessThanOrEqual(4);
    expect(Math.abs(a.h - 180)).toBeLessThanOrEqual(4);

    const out2 = f("stretch.mp4");
    expect((await render(out2, [{ overlay: solid("badge4.webm", "360x120"), x: 100, y: 100, width: 400, height: 400, fit: "stretch" }])).isError).toBe(false);
    const s = bbox(out2, 0.5, 1080, 1920, magenta);
    expect(Math.abs(s.w - 400)).toBeLessThanOrEqual(4);
    expect(Math.abs(s.h - 400)).toBeLessThanOrEqual(4);

    const out3 = f("full.mp4");
    expect((await render(out3, [{ overlay: solid("full.webm", "320x240") }])).isError).toBe(false);
    const full = bbox(out3, 0.5, 1080, 1920, magenta);
    expect(full).toMatchObject({ x: 0, y: 0, w: 1080, h: 1920 });
  });
});
