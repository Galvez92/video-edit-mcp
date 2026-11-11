import { describe, expect, it } from "vitest";
import { createProgressParser, type ProgressUpdate } from "../src/core/ffmpeg.js";

function collect() {
  const updates: ProgressUpdate[] = [];
  return { updates, parse: createProgressParser((u) => updates.push(u)) };
}

describe("ffmpeg progress parser", () => {
  it("reads a complete key=value block", () => {
    const { updates, parse } = collect();
    parse("frame=25\nfps=25.00\nout_time_us=1000000\nout_time=00:00:01.000000\nspeed=1.02x\nprogress=continue\n");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ outTimeSec: 1, frame: 25, fps: 25, speed: "1.02x", done: false });
  });

  it("reassembles blocks split across chunks", () => {
    const { updates, parse } = collect();
    parse("out_time_us=500000\nprogress=cont");
    parse("inue\nout_time_us=1500000\nprogress=end\n");
    expect(updates.map((u) => u.outTimeSec)).toEqual([0.5, 1.5]);
    expect(updates.map((u) => u.done)).toEqual([false, true]);
  });

  it("falls back to the out_time timestamp", () => {
    const { updates, parse } = collect();
    parse("out_time=00:00:02.500000\nprogress=continue\n");
    expect(updates[0]?.outTimeSec).toBe(2.5);
  });

  it("ignores lines that are not key=value pairs", () => {
    const { updates, parse } = collect();
    parse("noise\n=broken\nprogress=end\n");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.done).toBe(true);
  });
});
