import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseFasterWhisperJson, parseWhisperCppJson, whisperStatus } from "../src/core/whisper.js";
import { connectClient, hasFfmpeg } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUB = join(ROOT, "tests", "stub-whisper-cli.mjs");
/** Opt-in: real-backend transcription needs VEM_WHISPER_TESTS=1 plus an installed backend and model. */
const REAL_TESTS = process.env.VEM_WHISPER_TESTS === "1";

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

const status = await whisperStatus();

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

const text = (res: ToolResult): string => res.content[0].text;
const data = <T,>(res: ToolResult): T => JSON.parse(text(res)) as T;

/** First available local text-to-speech CLI, used to synthesize a speech fixture. */
function findSpeechTool(): string | undefined {
  for (const bin of ["espeak-ng", "espeak"]) {
    try {
      return execFileSync("which", [bin], { encoding: "utf8" }).trim();
    } catch {
      // not installed
    }
  }
  return undefined;
}

describe("transcript parsers", () => {
  it("normalizes whisper.cpp full JSON, merging sub-word tokens into words", () => {
    const parsed = parseWhisperCppJson(
      JSON.stringify({
        result: { language: "es" },
        transcription: [
          {
            offsets: { from: 0, to: 1000 },
            text: " Hola mundo",
            tokens: [
              { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
              { text: " Hola", offsets: { from: 0, to: 400 } },
              { text: " mun", offsets: { from: 400, to: 700 } },
              { text: "do", offsets: { from: 700, to: 1000 } },
            ],
          },
        ],
      }),
    );
    expect(parsed.language).toBe("es");
    expect(parsed.segments).toEqual([
      {
        start: 0,
        end: 1,
        text: "Hola mundo",
        words: [
          { start: 0, end: 0.4, text: "Hola" },
          { start: 0.4, end: 1, text: "mundo" },
        ],
      },
    ]);
  });

  it("falls back to HH:MM:SS,mmm timestamps when offsets are missing", () => {
    const parsed = parseWhisperCppJson(
      JSON.stringify({
        transcription: [{ timestamps: { from: "00:00:01,500", to: "00:00:02,750" }, text: " later" }],
      }),
    );
    expect(parsed.language).toBe("unknown");
    expect(parsed.segments).toEqual([{ start: 1.5, end: 2.75, text: "later" }]);
  });

  it("normalizes faster-whisper JSON", () => {
    const parsed = parseFasterWhisperJson(
      JSON.stringify({
        language: "en",
        segments: [
          {
            start: 0,
            end: 2,
            text: " Hi there",
            words: [
              { word: " Hi", start: 0, end: 0.5 },
              { word: " there", start: 0.5, end: 1 },
            ],
          },
          { start: 2, end: 3, text: " again", words: [] },
        ],
      }),
    );
    expect(parsed.language).toBe("en");
    expect(parsed.segments).toEqual([
      {
        start: 0,
        end: 2,
        text: "Hi there",
        words: [
          { start: 0, end: 0.5, text: "Hi" },
          { start: 0.5, end: 1, text: "there" },
        ],
      },
      { start: 2, end: 3, text: "again" },
    ]);
  });
});

describe("transcribe without a Whisper backend", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-whisper-none-"));
    writeFileSync(join(dir, "clip.wav"), "placeholder, never decoded");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns isError with an install hint, and health reports the backend as missing", async () => {
    vi.stubEnv("VEM_WHISPER_CMD", join(dir, "no-such-whisper-binary"));
    const client = await connectClient();

    const health = data<{ whisper: { available: boolean; hint?: string } }>(await call(client, "health", {}));
    expect(health.whisper.available).toBe(false);
    expect(health.whisper.hint).toMatch(/install/i);

    const res = await call(client, "transcribe", { input: join(dir, "clip.wav") });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Whisper backend unavailable/);
    expect(text(res)).toMatch(/whisper\.cpp|faster-whisper/);
    await client.close();
  });

  it("returns isError for a missing input file", async () => {
    vi.stubEnv("VEM_WHISPER_CMD", join(dir, "no-such-whisper-binary"));
    const client = await connectClient();

    const res = await call(client, "transcribe", { input: join(dir, "nope.wav") });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/input file not found/);
    await client.close();
  });
});

describe.skipIf(!hasFfmpeg)("transcribe with a stub backend (requires ffmpeg)", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-whisper-stub-"));
    execFileSync("bash", ["scripts/make-fixtures.sh", dir]);
    chmodSync(STUB, 0o755); // survives checkouts that drop the executable bit
    writeFileSync(join(dir, "ggml-stub.bin"), "stub model file, never read");
    vi.stubEnv("VEM_WHISPER_CMD", STUB);
    vi.stubEnv("VEM_WHISPER_MODEL", join(dir, "ggml-stub.bin"));
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts audio, runs the backend and returns segments plus words", async () => {
    const client = await connectClient();
    const res = await call(client, "transcribe", { input: join(dir, "testsrc.mp4") });
    expect(res.isError).toBeFalsy();
    const t = data<{
      backend: string;
      language: string;
      model?: string;
      segments: { start: number; end: number; text: string; words?: { start: number; end: number; text: string }[] }[];
    }>(res);

    expect(t.backend).toBe("whisper.cpp");
    expect(t.language).toBe("en");
    expect(t.model).toBe(join(dir, "ggml-stub.bin"));
    expect(t.segments).toHaveLength(2);
    expect(t.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 1.2],
      [1.2, 2.4],
    ]);
    expect(t.segments[0].text).toBe("Hello world");
    // sub-word tokens merged, special tokens ([_BEG_]) dropped
    expect(t.segments[0].words).toEqual([
      { start: 0.1, end: 0.5, text: "Hello" },
      { start: 0.5, end: 1, text: "world" },
    ]);

    let previous = -1;
    for (const s of t.segments) {
      expect(s.start).toBeGreaterThanOrEqual(previous);
      expect(s.end).toBeGreaterThanOrEqual(s.start);
      previous = s.start;
      for (const w of s.words ?? []) {
        expect(w.start).toBeGreaterThanOrEqual(s.start);
        expect(w.end).toBeLessThanOrEqual(s.end);
        expect(w.end).toBeGreaterThanOrEqual(w.start);
      }
    }
    await client.close();
  });

  it("omits words when wordTimestamps is false and reports the backend as available", async () => {
    const client = await connectClient();
    const health = data<{ whisper: { available: boolean; kind?: string; model?: string } }>(
      await call(client, "health", {}),
    );
    expect(health.whisper).toMatchObject({ available: true, kind: "whisper.cpp" });

    const res = await call(client, "transcribe", { input: join(dir, "tone.wav"), wordTimestamps: false });
    expect(res.isError).toBeFalsy();
    const t = data<{ segments: { words?: unknown }[] }>(res);
    expect(t.segments).toHaveLength(2);
    expect(t.segments.every((s) => s.words === undefined)).toBe(true);
    await client.close();
  });
});

const speechTool = findSpeechTool();
const realBackendReady = REAL_TESTS && hasFfmpeg && status.available && Boolean(speechTool);

describe.skipIf(!realBackendReady)("transcribe with a real Whisper backend (VEM_WHISPER_TESTS=1)", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vem-whisper-real-"));
    execFileSync(speechTool as string, ["-v", "en", "-w", join(dir, "speech.wav"), "the quick brown fox"]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns non-empty segments with monotonic times", async () => {
    const client = await connectClient();
    const res = await call(client, "transcribe", { input: join(dir, "speech.wav") });
    expect(res.isError).toBeFalsy();
    const t = data<{
      language: string;
      segments: { start: number; end: number; text: string; words?: { start: number; end: number }[] }[];
    }>(res);
    expect(t.segments.length).toBeGreaterThan(0);
    expect(t.segments.map((s) => s.text).join(" ").trim().length).toBeGreaterThan(0);
    expect(t.language).toBeTruthy();
    let previous = -1;
    for (const s of t.segments) {
      expect(s.start).toBeGreaterThanOrEqual(previous);
      previous = s.start;
    }
    await client.close();
  });
});

if (!realBackendReady) {
  console.warn(
    `transcribe: end-to-end test with a real Whisper backend skipped (por revisar) — ` +
      `backend=${status.available ? status.kind : "missing"}, speech tool=${speechTool ?? "missing"}, ` +
      `VEM_WHISPER_TESTS=${process.env.VEM_WHISPER_TESTS ?? "unset"}`,
  );
}
