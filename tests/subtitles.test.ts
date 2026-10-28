import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatAss,
  formatSrt,
  parseSrt,
  parseStamp,
  toAssTime,
  toSrtTime,
  wordsByLine,
  type SubtitleCue,
} from "../src/core/subtitles.js";

const fixture = readFileSync(new URL("./fixtures/sample.srt", import.meta.url), "utf8");

const timedCue: SubtitleCue = {
  start: 0,
  end: 1,
  lines: ["hello world"],
  words: [
    { start: 0, end: 0.4, text: "hello" },
    { start: 0.4, end: 1, text: "world" },
  ],
};

describe("srt", () => {
  it("parses the fixture into timed cues", () => {
    const cues = parseSrt(fixture);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toMatchObject({ start: 0, end: 1.4, lines: ["Caption pipelines start"] });
    expect(cues[2].end).toBe(5);
  });

  it("round-trips the fixture", () => {
    expect(formatSrt(parseSrt(fixture))).toBe(fixture);
  });

  it("formats and parses stamps in both dialects", () => {
    expect(toSrtTime(0)).toBe("00:00:00,000");
    expect(toSrtTime(3661.5)).toBe("01:01:01,500");
    expect(toAssTime(3661.5)).toBe("1:01:01.50");
    expect(parseStamp("00:00:01,500")).toBe(1.5);
    expect(parseStamp("0:00:01.50")).toBe(1.5);
    expect(() => parseStamp("nope")).toThrow(/invalid time stamp/);
  });

  it("rejects malformed input", () => {
    expect(() => parseSrt("1\nnot a timing line\nsome text")).toThrow(/invalid SRT timing line/);
    expect(() => parseSrt("\n\n")).toThrow(/no SRT cues found/);
  });
});

describe("ass", () => {
  it("writes a v4+ script with a style table and one dialogue per cue", () => {
    const ass = formatAss(parseSrt(fixture), { style: "plain", width: 1920, height: 1080 });
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Style: Caption,DejaVu Sans,");
    expect(ass).toContain("[Events]");
    const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(3);
    expect(dialogues[0]).toContain("0:00:00.00,0:00:01.40,Caption");
    expect(dialogues[0]).toContain("Caption pipelines start");
  });

  it("keeps multi-line cues on separate rows and strips inline markup", () => {
    const ass = formatAss([{ start: 0, end: 1, lines: ["one", "<i>two</i>"] }]);
    expect(ass).toContain("one\\Ntwo");
    expect(ass).not.toContain("<i>");
  });

  it("approximates karaoke with word timings", () => {
    const ass = formatAss([timedCue], { style: "karaoke" });
    expect(ass).toContain("{\\k40}hello {\\k60}world");
  });

  it("approximates pop with a scale-in", () => {
    expect(formatAss([{ start: 0, end: 1, lines: ["hi"] }], { style: "pop" })).toContain("\\t(0,160,\\fscx100\\fscy100)");
  });

  it("uses an opaque box for the box style", () => {
    const ass = formatAss([{ start: 0, end: 1, lines: ["hi"] }], { style: "box" });
    expect(ass).toMatch(/Style: Caption,[^\n]*,3,12,0,/);
  });

  it("falls back to plain text when karaoke has no word timings", () => {
    const ass = formatAss([{ start: 0, end: 1, lines: ["hello world"] }], { style: "karaoke" });
    expect(ass).not.toContain("\\k");
  });
});

describe("wordsByLine", () => {
  it("splits word timings across the display lines", () => {
    const cue: SubtitleCue = {
      start: 0,
      end: 2,
      lines: ["one two", "three"],
      words: [
        { start: 0, end: 0.5, text: "one" },
        { start: 0.5, end: 1, text: "two" },
        { start: 1, end: 2, text: "three" },
      ],
    };
    expect(wordsByLine(cue).map((line) => line.map((word) => word.text))).toEqual([["one", "two"], ["three"]]);
  });
});
