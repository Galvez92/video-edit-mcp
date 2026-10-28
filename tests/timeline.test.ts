import { describe, expect, it } from "vitest";
import { timelineDuration, validateClip, validateTimeline, type Timeline } from "../src/core/timeline.js";

describe("timeline", () => {
  it("computes duration as the longest track", () => {
    const tl: Timeline = {
      width: 1080, height: 1920, fps: 30,
      tracks: [
        { id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0, out: 2 }, { id: "b", src: "b.mp4", in: 1, out: 4 }] },
        { id: "m", kind: "audio", clips: [{ id: "c", src: "m.wav", in: 0, out: 3 }] },
      ],
    };
    expect(timelineDuration(tl)).toBe(5);
  });
  it("flags invalid clips", () => {
    expect(validateClip({ id: "x", src: "x", in: 2, out: 1 })).toHaveLength(1);
  });
});

describe("validateTimeline", () => {
  const valid: Timeline = {
    width: 1080, height: 1920, fps: 30,
    tracks: [{ id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0, out: 2 }] }],
  };

  it("accepts a well-formed timeline", () => {
    expect(validateTimeline(valid)).toEqual([]);
  });

  it("reports geometry, duplicate ids and empty tracks", () => {
    const errors = validateTimeline({
      width: 0, height: 1920, fps: 0,
      tracks: [
        { id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0, out: 2 }] },
        { id: "v", kind: "audio", clips: [] },
      ],
    });
    expect(errors).toContain("timeline: width and height must be > 0");
    expect(errors).toContain("timeline: fps must be > 0");
    expect(errors).toContain("track v: duplicate id");
    expect(errors).toContain("track v: no clips");
  });

  it("reports duplicate clip ids and bad ranges", () => {
    const errors = validateTimeline({
      ...valid,
      tracks: [
        { id: "v", kind: "video", clips: [{ id: "a", src: "a.mp4", in: 0, out: 2 }] },
        { id: "a", kind: "audio", clips: [{ id: "a", src: "m.wav", in: 3, out: 1 }] },
      ],
    });
    expect(errors).toContain("clip a: duplicate id");
    expect(errors).toContain("clip a: out must be > in");
  });
});
