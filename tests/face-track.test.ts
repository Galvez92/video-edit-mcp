import { describe, expect, it } from "vitest";
import { buildCropTrajectory, clampEven, loadFaceDetector, type FaceDetection } from "../src/core/face-track.js";

describe("clampEven", () => {
  it("rounds to the nearest even value within bounds", () => {
    expect(clampEven(135, 2, 320)).toBe(136);
    expect(clampEven(180, 2, 320)).toBe(180);
    expect(clampEven(192, 2, 320)).toBe(192);
    expect(clampEven(1, 2, 320)).toBe(2);
    expect(clampEven(1000, 2, 320)).toBe(320);
    expect(clampEven(7, 0, 8)).toBe(8); // 7 rounds half-up to 8
  });
});

describe("buildCropTrajectory", () => {
  // 320x240 source reframed to 9:16: crop the sides (axis x), crop window 136x240, span 184.
  const src = { w: 320, h: 240 };
  const crop = { w: 136, h: 240 };

  it("centers the crop on each detected face and clamps to the available room", () => {
    const detections: FaceDetection[] = [
      { t: 0.5, cx: 0.2, cy: 0.5 }, // face near the left -> offset clamped toward 0
      { t: 1.5, cx: 0.9, cy: 0.5 }, // face near the right -> offset toward the max span
      { t: 2.5, cx: 0.5, cy: 0.5 }, // centered face -> mid offset
    ];
    const traj = buildCropTrajectory(detections, src, crop);
    expect(traj.axis).toBe("x");
    expect(traj.offsets).toHaveLength(3);
    // offsets are even, within [0, span]
    for (const o of traj.offsets) {
      expect(o.x % 2).toBe(0);
      expect(o.x).toBeGreaterThanOrEqual(0);
      expect(o.x).toBeLessThanOrEqual(184);
      expect(o.y).toBe(0);
    }
    // left face (cx 0.2): desired = 0.2*320 - 68 = -4 -> clamped to 0
    expect(traj.offsets[0].x).toBe(0);
    // right face (cx 0.9): desired = 0.9*320 - 68 = 220 -> clamped to span 184
    expect(traj.offsets[1].x).toBe(184);
    // centered face: desired = 160 - 68 = 92
    expect(traj.offsets[2].x).toBe(92);
    // expression interpolates and escapes commas for a single crop option
    expect(traj.expression).toContain("if(between(t\\,");
    expect(traj.expression).toContain("lt(t\\,");
  });

  it("falls back to a single centered offset when there are no detections", () => {
    const traj = buildCropTrajectory([], src, crop);
    expect(traj.axis).toBe("x");
    expect(traj.offsets).toHaveLength(1);
    expect(traj.offsets[0].x).toBe(92); // span/2 = 184/2
    expect(traj.expression).toBe("92");
  });

  it("slides along the y axis when reframing a tall source to 16:9", () => {
    // 240x320 source -> 16:9: crop top/bottom, window 240x135 (even), span 184 on y
    const traj = buildCropTrajectory(
      [
        { t: 0.4, cx: 0.5, cy: 0.1 }, // face near top -> y clamped to 0
        { t: 1.2, cx: 0.5, cy: 0.9 }, // face near bottom -> y toward span
      ],
      { w: 240, h: 320 },
      { w: 240, h: 136 },
    );
    expect(traj.axis).toBe("y");
    expect(traj.offsets[0].y).toBe(0);
    expect(traj.offsets[1].y).toBe(184);
    for (const o of traj.offsets) expect(o.x).toBe(0);
  });

  it("reports a null axis when the source already matches the aspect", () => {
    const traj = buildCropTrajectory([{ t: 0, cx: 0.5, cy: 0.5 }], { w: 100, h: 100 }, { w: 100, h: 100 });
    expect(traj.axis).toBeNull();
    expect(traj.expression).toBe("0");
  });
});

describe("loadFaceDetector", () => {
  it("returns null when no detector module is configured", async () => {
    const previous = process.env.REFRAME_FACE_MODULE;
    delete process.env.REFRAME_FACE_MODULE;
    expect(await loadFaceDetector()).toBeNull();
    if (previous !== undefined) process.env.REFRAME_FACE_MODULE = previous;
  });

  it("returns null when the configured module cannot be resolved", async () => {
    const previous = process.env.REFRAME_FACE_MODULE;
    process.env.REFRAME_FACE_MODULE = "@no-such/detector-module-xyz";
    expect(await loadFaceDetector()).toBeNull();
    if (previous !== undefined) process.env.REFRAME_FACE_MODULE = previous;
    else delete process.env.REFRAME_FACE_MODULE;
  });
});
