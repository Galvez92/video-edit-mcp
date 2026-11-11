/** Interchange tools: import edit decisions from other editors (EDL, OpenTimelineIO) as a timeline. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { importEdl, importOtio } from "../core/interchange.js";
import { fail, json } from "./result.js";

const message = (err: unknown): string => (err as Error).message;

/** Frame size the imported timeline uses (EDL/OTIO carry no frame geometry); presets may override it in `render`. */
const geometryInput = {
  width: z.number().int().positive().optional().describe("Timeline width in pixels (default 1920)"),
  height: z.number().int().positive().optional().describe("Timeline height in pixels (default 1080)"),
};

/** Register the EDL and OpenTimelineIO import tools on the server. */
export function registerInterchangeTools(server: McpServer): void {
  server.registerTool(
    "import.edl",
    {
      description:
        "Import a CMX3600 EDL as a timeline you can pass to `render`. Each event becomes a clip placed at its " +
        "record position (source in/out from its timecodes), so gaps in the record become gaps in the program; " +
        "dissolves become crossfades. Track tokens: V/B → video, A/A2/AA → audio, AA/V → both.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the .edl file"),
        fps: z.number().positive().optional().describe("Frame rate the timecodes are counted in (default 25)"),
        mediaMap: z
          .record(z.string(), z.string())
          .optional()
          .describe("Reel name → local media path. Reels left out are used as the source path as written"),
        ...geometryInput,
      },
    },
    async ({ path, fps, mediaMap, width, height }) => {
      try {
        return json(await importEdl({ path, fps, mediaMap, width, height }));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "import.otio",
    {
      description:
        "Import an OpenTimelineIO JSON file as a timeline you can pass to `render`. Clips keep their source " +
        "in-point and their position on the track (gaps are preserved); media paths come from each clip's " +
        "DEFAULT_MEDIA reference. The frame rate is taken from the file's rational times.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the .otio (JSON) file"),
        ...geometryInput,
      },
    },
    async ({ path, width, height }) => {
      try {
        return json(await importOtio({ path, width, height }));
      } catch (err) {
        return fail(message(err));
      }
    },
  );
}
