import { describe, expect, it } from "vitest";
import { buildCompositionHtml, chunkSegments, wordsForSegment } from "../src/core/captions.js";
import type { SubtitleCue } from "../src/core/subtitles.js";

/** Same rounding the composition writer uses for its timing attributes. */
const sec = (value: number): string => String(Math.round(value * 1000) / 1000);

describe("wordsForSegment", () => {
  it("keeps source word timings when they line up with the tokens", () => {
    const words = wordsForSegment({
      start: 0,
      end: 2,
      text: "hi there",
      words: [
        { start: 0.5, end: 0.8, text: "hi" },
        { start: 1.2, end: 1.9, text: "there" },
      ],
    });
    expect(words).toMatchObject([
      { start: 0.5, end: 0.8, text: "hi" },
      { start: 1.2, end: 1.9, text: "there" },
    ]);
  });

  it("splits the segment span proportionally without word timings", () => {
    const words = wordsForSegment({ start: 0, end: 4, text: "aa bbbb" });
    expect(words).toHaveLength(2);
    expect(words[0].start).toBe(0);
    expect(words[0].end).toBeCloseTo(words[1].start, 6);
    expect(words[1].end).toBeCloseTo(4, 6);
  });

  it("ignores partial word timings", () => {
    const words = wordsForSegment({
      start: 0,
      end: 2,
      text: "one two three",
      words: [{ start: 0, end: 1, text: "one" }],
    });
    expect(words).toHaveLength(3);
    expect(words[0].start).toBe(0);
    expect(words[2].end).toBeCloseTo(2, 6);
  });
});

describe("chunkSegments", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve";

  it("wraps lines and packs chunks within the limits", () => {
    const cues = chunkSegments([{ start: 0, end: 12, text }], { maxCharsPerLine: 12, maxLines: 2 });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      expect(cue.end).toBeGreaterThan(cue.start);
      for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(12);
    }
    expect(cues.flatMap((cue) => cue.words?.map((word) => word.text) ?? []).join(" ")).toBe(text);
  });

  it("keeps chunk times monotonic across the segment", () => {
    const cues = chunkSegments([{ start: 0, end: 12, text }], { maxCharsPerLine: 12, maxLines: 2 });
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index].start).toBeGreaterThanOrEqual(cues[index - 1].end - 0.001);
    }
  });

  it("drops empty segments and sorts by start", () => {
    const cues = chunkSegments([
      { start: 4, end: 5, text: "later" },
      { start: 0, end: 1, text: "   " },
      { start: 1, end: 2, text: "first" },
    ]);
    expect(cues.map((cue) => cue.lines.join(" "))).toEqual(["first", "later"]);
  });

  it("keeps an over-long word on its own line", () => {
    const cues = chunkSegments([{ start: 0, end: 2, text: "extraordinarily longword" }], {
      maxCharsPerLine: 8,
      maxLines: 1,
    });
    expect(cues.map((cue) => cue.lines)).toEqual([["extraordinarily"], ["longword"]]);
  });
});

describe("buildCompositionHtml", () => {
  const cues: SubtitleCue[] = chunkSegments([{ start: 0, end: 4, text: "one two three four five six seven eight nine ten" }], {
    maxCharsPerLine: 10,
    maxLines: 1,
  });

  it("emits one timed element per caption chunk inside a sized composition", () => {
    const html = buildCompositionHtml(cues, { style: "pop", width: 720, height: 1280, duration: 6 });
    expect(html).toContain('data-composition-id="captions"');
    expect(html).toContain('data-width="720"');
    expect(html).toContain('data-height="1280"');
    expect(html).toContain('data-duration="6"');
    const starts = [...html.matchAll(/class="hf-cue [^"]*" data-start="([^"]+)"/g)].map((match) => match[1]);
    expect(starts).toEqual(cues.map((cue) => sec(cue.start)));
    for (const cue of cues) {
      expect(html).toContain(`data-duration="${sec(cue.end - cue.start)}"`);
    }
  });

  it("defaults the composition duration to the last cue", () => {
    const html = buildCompositionHtml(cues);
    expect(html).toContain(`data-duration="${sec(cues[cues.length - 1].end)}"`);
  });

  it("marks karaoke words with a delay relative to the cue start", () => {
    const cue: SubtitleCue = {
      start: 1,
      end: 2,
      lines: ["one two"],
      words: [
        { start: 1, end: 1.4, text: "one" },
        { start: 1.4, end: 1.9, text: "two" },
      ],
    };
    const html = buildCompositionHtml([cue], { style: "karaoke" });
    expect(html).toContain('class="hf-cue hf-cue--karaoke"');
    expect(html).toContain('class="hf-word" style="--hf-delay:0s">one');
    expect(html).toContain('style="--hf-delay:0.4s">two');
    expect(html).toContain("@keyframes hf-word-in");
  });

  it("escapes markup from the transcript", () => {
    const html = buildCompositionHtml([{ start: 0, end: 1, lines: ["a & b <c>"] }]);
    expect(html).toContain("a &amp; b &lt;c&gt;");
  });
});
