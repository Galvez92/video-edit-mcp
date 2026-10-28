import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { concat, cut, trim, type OnProgress } from "./core/edit.js";
import { health, probe } from "./core/ffmpeg.js";
import { compose } from "./core/compose.js";
import { exportPackage, PRESET_NAMES, render } from "./core/render.js";

export const SERVER_NAME = "video-edit-mcp";
export const SERVER_VERSION = "0.1.0";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });
const message = (err: unknown) => (err as Error).message;

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Stream ffmpeg progress to the client, but only when it asked for progress updates. */
function reporter(extra: ToolExtra): OnProgress {
  return (update, totalSec) => {
    const token = extra._meta?.progressToken;
    if (token === undefined) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: update.outTimeSec, total: totalSec },
    });
  };
}

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
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "trim",
    {
      description:
        "Cut one range out of a media file. Stream-copies when the range starts on a keyframe, re-encodes otherwise.",
      inputSchema: {
        input: z.string().min(1).describe("Source media path"),
        start: z.number().describe("Range start in seconds"),
        end: z.number().describe("Range end in seconds (exclusive)"),
        output: z.string().min(1).describe("Output file path"),
        reencode: z.boolean().optional().describe("Force re-encoding (true) or a stream copy (false); auto-detected by default"),
        overwrite: z.boolean().optional().describe("Replace the output file if it already exists (default false)"),
      },
    },
    async (args, extra) => {
      try {
        return json(await trim({ ...args, onProgress: reporter(extra) }));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "cut",
    {
      description: "Keep the listed ranges of one file and join them in order, always re-encoded.",
      inputSchema: {
        input: z.string().min(1).describe("Source media path"),
        segments: z
          .array(z.object({ start: z.number().describe("Segment start in seconds"), end: z.number().describe("Segment end in seconds") }))
          .min(1)
          .describe("Ranges to keep, in output order"),
        output: z.string().min(1).describe("Output file path"),
        overwrite: z.boolean().optional().describe("Replace the output file if it already exists (default false)"),
      },
    },
    async (args, extra) => {
      try {
        return json(await cut({ ...args, onProgress: reporter(extra) }));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "concat",
    {
      description:
        "Join several media files into one. Normalization scales/pads resolution, fps and audio to a common layout first.",
      inputSchema: {
        inputs: z.array(z.string().min(1)).min(2).describe("Input media paths, in output order"),
        output: z.string().min(1).describe("Output file path"),
        normalize: z.boolean().optional().describe("Normalize resolution/fps/audio before joining (default true)"),
        overwrite: z.boolean().optional().describe("Replace the output file if it already exists (default false)"),
      },
    },
    async (args, extra) => {
      try {
        return json(await concat({ ...args, onProgress: reporter(extra) }));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "render",
    {
      description:
        "Encode a file with a fixed delivery preset: web-1080p (16:9), vertical-9x16, square (H.264+AAC, fit-and-pad) or audio-only (AAC .m4a).",
      inputSchema: {
        input: z.string().min(1).describe("Source media path"),
        preset: z.enum(PRESET_NAMES).describe("Encode preset"),
        output: z.string().min(1).describe("Output file path (.mp4 for video presets, .m4a for audio-only)"),
        overwrite: z.boolean().optional().describe("Replace the output file if it already exists (default false)"),
      },
    },
    async (args, extra) => {
      try {
        return json(await render({ ...args, onProgress: reporter(extra) }));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "export.package",
    {
      description:
        "Build a delivery ZIP: the media file, optional captions.srt, spec.json (measured duration, resolution, fps, codecs, EBU R128 loudness, preset) and checksums.sha256.",
      inputSchema: {
        video: z.string().min(1).describe("Rendered media file to deliver"),
        output: z.string().min(1).describe("Output .zip path"),
        subtitles: z.string().min(1).optional().describe("Optional .srt file, stored as captions.srt"),
        preset: z.string().optional().describe("Preset name recorded in spec.json"),
        overwrite: z.boolean().optional().describe("Replace the output file if it already exists (default false)"),
      },
    },
    async (args) => {
      try {
        return json(await exportPackage(args));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "compose",
    {
      description:
        "Render a HyperFrames composition (HTML) to video. Needs the optional peer @hyperframes/producer and headless Chrome; returns an 'unavailable' error otherwise.",
      inputSchema: {
        composition: z.string().min(1).describe("Path to the HyperFrames composition HTML"),
        output: z.string().min(1).describe("Output video path"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
      },
    },
    async (args) => {
      try {
        return json(await compose(args));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  return server;
}
