/**
 * Local speech-to-text with Whisper (no cloud).
 *
 * The Whisper engine is an OPTIONAL local CLI, never a package dependency: either
 * whisper.cpp (`whisper-cli`) or a faster-whisper CLI (`faster-whisper`,
 * `whisper-ctranslate2`). Nothing is probed or loaded at import time — the backend is
 * detected lazily on the first tool call, and the process keeps a small cache.
 *
 * Audio is extracted with ffmpeg to 16 kHz mono WAV, transcribed into a temporary
 * directory, and the transcript (segments + optional word timestamps) is normalized
 * from the backend's JSON output.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg, run } from "./ffmpeg.js";

export type WhisperKind = "whisper.cpp" | "faster-whisper";

export interface WhisperBackend {
  kind: WhisperKind;
  /** Binary invoked (bare name resolved through PATH, or an explicit path). */
  command: string;
}

export interface WhisperStatus extends Partial<WhisperBackend> {
  available: boolean;
  /** Model file (whisper.cpp) or model name (faster-whisper). */
  model?: string;
  error?: string;
  hint?: string;
}

export const INSTALL_HINT =
  'Install a local Whisper backend: whisper.cpp (binary "whisper-cli" or "whisper-cpp") or faster-whisper ' +
  '("pip install faster-whisper", provides "faster-whisper"/"whisper-ctranslate2"), or point VEM_WHISPER_CMD at one.';

const MODEL_HINT =
  "Set VEM_WHISPER_MODEL to a converted model file (e.g. ggml-base.bin) or keep ggml-<model>.bin in VEM_WHISPER_MODEL_DIR.";

/** Tried in order when VEM_WHISPER_CMD is not set. */
const CANDIDATES = ["whisper-cli", "whisper-cpp", "faster-whisper", "whisper-ctranslate2", "whisper"];

const PROBE_TIMEOUT_MS = 10_000;
const runTimeoutMs = (): number => Number(process.env.VEM_WHISPER_TIMEOUT_MS ?? 600_000);

interface ProbeResult {
  backend: WhisperBackend;
  help: string;
}

/** Run `<command> -h` and classify the CLI from its help text. */
async function probe(command: string): Promise<ProbeResult | null> {
  for (const flag of ["-h", "--help"]) {
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = await run(command, [flag], PROBE_TIMEOUT_MS);
    } catch {
      return null; // not found or not executable
    }
    if (r.code !== 0) continue;
    const help = `${r.stdout}\n${r.stderr}`;
    const forced = process.env.VEM_WHISPER_BACKEND;
    const kind: WhisperKind =
      forced === "whisper.cpp" || forced === "faster-whisper"
        ? forced
        : /output-json|-oj[a-z]?\b/.test(help)
          ? "whisper.cpp"
          : /word_timestamps|output_dir/.test(help)
            ? "faster-whisper"
            : "whisper.cpp";
    return { backend: { kind, command }, help };
  }
  return null;
}

const envKey = (): string => [process.env.VEM_WHISPER_CMD, process.env.VEM_WHISPER_BACKEND].join("\u0000");
let cache: { key: string; backend: WhisperBackend | null } | undefined;

/** Detect the local Whisper backend (lazy, cached while the environment is unchanged). */
export async function detectBackend(): Promise<WhisperBackend | null> {
  const key = envKey();
  if (cache?.key === key) return cache.backend;
  const candidates = process.env.VEM_WHISPER_CMD ? [process.env.VEM_WHISPER_CMD] : CANDIDATES;
  let backend: WhisperBackend | null = null;
  for (const candidate of candidates) {
    const probed = await probe(candidate);
    if (probed) {
      backend = probed.backend;
      break;
    }
  }
  cache = { key, backend };
  return backend;
}

/** Resolve the whisper.cpp model file (ggml-<name>.bin) to use. */
export function resolveModelFile(model?: string): string | undefined {
  const explicit = process.env.VEM_WHISPER_MODEL;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const name = model ?? "base";
  if (name.endsWith(".bin") && existsSync(name)) return name;
  const file = name.endsWith(".bin") ? name : `ggml-${name}.bin`;
  const dirs = [process.env.VEM_WHISPER_MODEL_DIR, "models", "."].filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** Backend + model availability, as reported by the `health` tool. */
export async function whisperStatus(model?: string): Promise<WhisperStatus> {
  const backend = await detectBackend();
  if (!backend) return { available: false, error: "no local Whisper backend found", hint: INSTALL_HINT };
  if (backend.kind === "faster-whisper") return { available: true, ...backend, model: model ?? "base" };
  const file = resolveModelFile(model);
  if (!file) return { available: false, ...backend, error: "Whisper model file not found", hint: MODEL_HINT };
  return { available: true, ...backend, model: file };
}

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface Transcript {
  language: string;
  backend: WhisperKind;
  model?: string;
  segments: TranscriptSegment[];
}

export interface TranscribeOptions {
  input: string;
  model?: string;
  language?: string;
  wordTimestamps?: boolean;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
/** whisper.cpp reports integer millisecond offsets. */
const offsetSec = (ms?: number): number | undefined => (typeof ms === "number" ? r3(ms / 1000) : undefined);
/** Fallback for backends that only emit "HH:MM:SS,mmm" strings. */
const parseTimestamp = (ts?: string): number | undefined => {
  const m = ts?.match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return undefined;
  return r3(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000);
};

interface CppToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  timestamps?: { from?: string; to?: string };
}

interface CppSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  timestamps?: { from?: string; to?: string };
  tokens?: CppToken[];
}

/** Tokens that carry no speech: [_BEG_], [_TT_42], [BLANK_AUDIO], ... */
const SPECIAL_TOKEN = /^\[[_A-Z].*\]$/;

/** whisper.cpp emits sub-word tokens; a token starting with a space begins a new word. */
function tokensToWords(tokens: CppToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const token of tokens) {
    const raw = token.text ?? "";
    const text = raw.trim();
    if (!text || SPECIAL_TOKEN.test(text)) continue;
    const start = offsetSec(token.offsets?.from) ?? parseTimestamp(token.timestamps?.from) ?? 0;
    const end = offsetSec(token.offsets?.to) ?? parseTimestamp(token.timestamps?.to) ?? start;
    const last = words[words.length - 1];
    if (!last || raw.startsWith(" ")) words.push({ start, end, text });
    else {
      last.text += text;
      last.end = end;
    }
  }
  return words;
}

/** Parse whisper.cpp full JSON output (`-ojf`). */
export function parseWhisperCppJson(json: string): { language: string; segments: TranscriptSegment[] } {
  const data = JSON.parse(json) as { result?: { language?: string }; transcription?: CppSegment[] };
  const segments = (data.transcription ?? []).map((s) => {
    const start = offsetSec(s.offsets?.from) ?? parseTimestamp(s.timestamps?.from) ?? 0;
    const end = offsetSec(s.offsets?.to) ?? parseTimestamp(s.timestamps?.to) ?? start;
    const words = tokensToWords(s.tokens ?? []);
    return { start, end, text: (s.text ?? "").trim(), ...(words.length ? { words } : {}) };
  });
  return { language: data.result?.language ?? "unknown", segments };
}

/** Parse faster-whisper / whisper-ctranslate2 JSON output (`--output_format json`). */
export function parseFasterWhisperJson(json: string): { language: string; segments: TranscriptSegment[] } {
  const data = JSON.parse(json) as {
    language?: string;
    segments?: {
      start?: number;
      end?: number;
      text?: string;
      words?: { word?: string; start?: number; end?: number }[];
    }[];
  };
  const segments = (data.segments ?? []).map((s) => {
    const start = r3(s.start ?? 0);
    const end = r3(s.end ?? start);
    const words = (s.words ?? [])
      .filter((w) => (w.word ?? "").trim().length > 0)
      .map((w) => ({ start: r3(w.start ?? start), end: r3(w.end ?? w.start ?? start), text: (w.word ?? "").trim() }));
    return { start, end, text: (s.text ?? "").trim(), ...(words.length ? { words } : {}) };
  });
  return { language: data.language ?? "unknown", segments };
}

/** Transcribe a local media file with the detected Whisper backend. */
export async function transcribe(opts: TranscribeOptions): Promise<Transcript> {
  const { input } = opts;
  if (!existsSync(input)) throw new Error(`input file not found: ${input}`);

  const status = await whisperStatus(opts.model);
  if (!status.available || !status.kind || !status.command) {
    throw new Error(`Whisper backend unavailable: ${status.error}. ${status.hint ?? ""}`.trim());
  }

  const dir = await mkdtemp(join(tmpdir(), "vem-whisper-"));
  try {
    const wav = join(dir, "audio.wav");
    const extracted = await ffmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    if (extracted.code !== 0) {
      throw new Error(`ffmpeg failed to extract audio: ${extracted.stderr.trim().slice(-400)}`);
    }

    const model = status.model ?? "base";
    const wantWords = opts.wordTimestamps !== false;
    const args =
      status.kind === "whisper.cpp"
        ? [
            "-m",
            model,
            "-f",
            wav,
            "-ojf", // full JSON: segments plus token-level timestamps
            "-of",
            join(dir, "out"),
            ...(opts.language ? ["-l", opts.language] : []),
          ]
        : [
            wav,
            "--model",
            model,
            "--output_dir",
            dir,
            "--output_format",
            "json",
            "--word_timestamps",
            wantWords ? "True" : "False",
            ...(opts.language ? ["--language", opts.language] : []),
          ];

    const result = await run(status.command, args, runTimeoutMs());
    if (result.code !== 0) {
      throw new Error(`${status.kind} failed (exit ${result.code}): ${result.stderr.trim().slice(-400)}`);
    }

    const jsonPath = status.kind === "whisper.cpp" ? join(dir, "out.json") : join(dir, "audio.json");
    if (!existsSync(jsonPath)) throw new Error(`${status.kind} produced no JSON transcript (expected ${jsonPath})`);
    const raw = await readFile(jsonPath, "utf8");
    const parsed = status.kind === "whisper.cpp" ? parseWhisperCppJson(raw) : parseFasterWhisperJson(raw);

    const segments = wantWords
      ? parsed.segments
      : parsed.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
    return { language: parsed.language, backend: status.kind, model: status.model, segments };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
