import { describe, expect, it } from "vitest";
import { timelineDuration, validateClip, type Timeline } from "../src/core/timeline.js";

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
