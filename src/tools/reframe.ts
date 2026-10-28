/** reframe tool: change a video's aspect ratio with a centered crop, padding, or subject-following crop. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reframe } from "../core/reframe.js";
import { fail, json } from "./result.js";

/** Register the reframe tool on the server. */
export function registerReframeTool(server: McpServer): void {
  server.registerTool(
    "reframe",
    {
      description:
        "Reframe a video to 9:16, 1:1, 16:9 or 4:5. Modes: a centered crop (default), solid-color padding, " +
        'or blurred-background padding. In "crop" mode, focusX/focusY bias the crop (0..1), and "follow" ' +
        "tracks the subject across time using an optional, lazily-loaded face detector.",
      inputSchema: {
        input: z.string().min(1).describe("Path to the source video"),
        output: z.string().min(1).describe("Path of the reframed video to write"),
        aspect: z.enum(["9:16", "1:1", "16:9", "4:5"]).describe("Target aspect ratio"),
        mode: z
          .enum(["crop", "pad", "blur-pad"])
          .optional()
          .describe('"crop" (default), "pad" (solid color) or "blur-pad" (blurred background).'),
        focusX: z.number().min(0).max(1).optional().describe("Horizontal crop focus, 0 (left) .. 1 (right). Default 0.5 (center)."),
        focusY: z.number().min(0).max(1).optional().describe("Vertical crop focus, 0 (top) .. 1 (bottom). Default 0.5 (center)."),
        follow: z.boolean().optional().describe("Track the subject over time with a lazy face detector (crop mode only)."),
        height: z.number().int().min(2).optional().describe("Output height in pixels (default: crop/source height)."),
        padColor: z.string().optional().describe('ffmpeg pad color for "pad" mode (e.g. "black", "0x0000ff"). Default "black".'),
        overwrite: z.boolean().optional().describe("Replace the output file if it exists (default false)."),
      },
    },
    async ({ input, output, aspect, mode, focusX, focusY, follow, height, padColor, overwrite }) => {
      try {
        const result = await reframe({
          input,
          output,
          aspect,
          mode,
          focusX,
          focusY,
          follow,
          height,
          padColor,
          overwrite,
        });
        return json(result);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}
