import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { health, probe } from "./core/ffmpeg.js";
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

  return server;
}
