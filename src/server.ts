import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { health, probe } from "./core/ffmpeg.js";
import { loudnorm, measure, mix } from "./core/audiomix.js";
import { transcribe, whisperStatus } from "./core/whisper.js";

export const SERVER_NAME = "video-edit-mcp";
export const SERVER_VERSION = "0.1.0";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

/** Build the MCP server and register every implemented tool. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "health",
    { description: "Report whether ffmpeg/ffprobe and a local Whisper backend are available, with versions." },
    async () => json({ ...(await health()), whisper: await whisperStatus() }),
  );

  server.registerTool(
    "probe",
    {
      description: "Inspect a local media file: container, duration, size and per-stream codec/resolution/fps/audio info.",
      inputSchema: { path: z.string().min(1).describe("Absolute or relative path to a local media file") },
    },
    async ({ path }) => {
      try {
        return json(await probe(path));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "transcribe",
    {
      description:
        "Transcribe a local audio or video file with a local Whisper backend (whisper.cpp or faster-whisper): " +
        "audio is extracted with ffmpeg to 16 kHz mono, and segments plus word-level timestamps are returned.",
      inputSchema: {
        input: z.string().min(1).describe("Path to a local audio or video file"),
        model: z
          .string()
          .min(1)
          .optional()
          .describe('Whisper model (default "base"; with whisper.cpp the ggml-<model>.bin file must exist)'),
        language: z.string().min(1).optional().describe("ISO-639-1 language code; omit to auto-detect"),
        wordTimestamps: z.boolean().optional().describe("Include word-level timestamps (default true)"),
      },
    },
    async ({ input, model, language, wordTimestamps }) => {
      try {
        return json(await transcribe({ input, model, language, wordTimestamps }));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "audio.measure",
    {
      description: "Measure integrated loudness (LUFS), true peak (dBTP) and loudness range (LRA) of a media file with ffmpeg loudnorm.",
      inputSchema: { input: z.string().min(1).describe("Path to a local audio or video file") },
    },
    async ({ input }) => {
      try {
        return json(await measure(input));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "audio.loudnorm",
    {
      description: "Two-pass loudness normalization of a media file to a target integrated loudness (default -14 LUFS) using ffmpeg loudnorm.",
      inputSchema: {
        input: z.string().min(1).describe("Path to a local audio or video file"),
        targetLufs: z.number().optional().describe("Target integrated loudness in LUFS (default -14)"),
        truePeak: z.number().optional().describe("Target true peak in dBTP (default -1.5)"),
        output: z.string().min(1).describe("Path to write the normalized file"),
      },
    },
    async ({ input, targetLufs, truePeak, output }) => {
      try {
        return json(await loudnorm({ input, targetLufs, truePeak, output }));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "audio.mix",
    {
      description:
        "Mix a video's voice track with background music, ducking the music under the voice with a sidechain compressor. " +
        "Video is kept (stream copy); audio is re-encoded. Fades optional.",
      inputSchema: {
        video: z.string().min(1).describe("Video file whose audio track is the voice"),
        music: z.string().min(1).describe("Background music file"),
        musicGainDb: z.number().optional().describe("Gain applied to the music in dB before ducking"),
        duck: z
          .object({
            threshold: z.number().optional(),
            ratio: z.number().optional(),
            attack: z.number().optional(),
            release: z.number().optional(),
          })
          .optional()
          .describe("Sidechain-compressor ducking keyed on the voice (dB threshold, ratio, attack/release in ms)"),
        fadeIn: z.number().optional().describe("Fade-in duration in seconds (default 0)"),
        fadeOut: z.number().optional().describe("Fade-out duration in seconds (default 0)"),
        output: z.string().min(1).describe("Path to write the mixed file"),
      },
    },
    async ({ video, music, musicGainDb, duck, fadeIn, fadeOut, output }) => {
      try {
        return json(await mix({ video, music, musicGainDb, duck, fadeIn, fadeOut, output }));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  return server;
}
