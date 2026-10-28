import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { health, probe } from "./core/ffmpeg.js";
import { registerCaptionTools } from "./tools/captions.js";
import { registerReframeTool } from "./tools/reframe.js";
import { fail, json } from "./tools/result.js";

export const SERVER_NAME = "video-edit-mcp";
export const SERVER_VERSION = "0.1.0";

/** Build the MCP server and register every implemented tool. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "health",
    { description: "Report whether ffmpeg and ffprobe are available, with their versions." },
    async () => json(await health()),
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

  registerCaptionTools(server);
  registerReframeTool(server);

  return server;
}
