/** Caption tools: generate SRT/ASS/composition files and burn captions onto a video. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderCaptions } from "../core/caption-render.js";
import { loadCues } from "../core/caption-source.js";
import { buildCompositionHtml } from "../core/captions.js";
import { formatAss, formatSrt, type SubtitleCue } from "../core/subtitles.js";
import { fail, json } from "./result.js";

const wordSchema = z.object({
  start: z.number().describe("Word start in seconds"),
  end: z.number().describe("Word end in seconds"),
  text: z.string(),
});

const segmentSchema = z.object({
  start: z.number().describe("Segment start in seconds"),
  end: z.number().describe("Segment end in seconds"),
  text: z.string(),
  words: z.array(wordSchema).optional().describe("Word-level timings, when the transcriber produced them"),
});

const styleSchema = z
  .enum(["plain", "karaoke", "pop", "box"])
  .optional()
  .describe('Caption style: "plain", "karaoke" (word highlight), "pop" (scale-in), "box" (background plate). Default "plain".');

const sourceShape = {
  transcript: z
    .union([z.array(segmentSchema), z.string()])
    .optional()
    .describe("Transcription segments (inline), or a path to a JSON file holding an array of segments or {segments:[…]}"),
  srt: z.string().optional().describe("Path to an input .srt file (used as-is, lines and timings preserved)"),
  style: styleSchema,
  maxCharsPerLine: z.number().int().min(8).optional().describe("Transcript wrapping limit per line (default 42)"),
  maxLines: z.number().int().min(1).optional().describe("Transcript lines per caption chunk (default 2)"),
};

const lastEnd = (cues: SubtitleCue[]): number => cues.reduce((max, cue) => Math.max(max, cue.end), 0);

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** Register the caption tools on the server. */
export function registerCaptionTools(server: McpServer): void {
  server.registerTool(
    "captions.generate",
    {
      description:
        "Write captions from transcription segments or an SRT file: subtitle files (srt/ass) or a HyperFrames " +
        "composition HTML for animated captions (karaoke word highlight, word-pop, background box).",
      inputSchema: {
        ...sourceShape,
        format: z.enum(["srt", "ass", "hyperframes"]).describe("Output format"),
        output: z.string().min(1).describe("Path of the file to write"),
        width: z.number().int().min(16).optional().describe("Frame width for ass/hyperframes output (default 1080)"),
        height: z.number().int().min(16).optional().describe("Frame height for ass/hyperframes output (default 1920)"),
        duration: z.number().positive().optional().describe("Composition duration in seconds (default: end of the last cue)"),
      },
    },
    async ({ transcript, srt, style, maxCharsPerLine, maxLines, format, output, width, height, duration }) => {
      try {
        const cues = await loadCues({ transcript, srt, style, maxCharsPerLine, maxLines });
        const resolved = style ?? "plain";
        const content =
          format === "srt"
            ? formatSrt(cues)
            : format === "ass"
              ? formatAss(cues, { style: resolved, width, height })
              : buildCompositionHtml(cues, { style: resolved, width, height, duration });
        await writeText(output, content);
        return json({
          output,
          format,
          style: resolved,
          cues: cues.length,
          bytes: Buffer.byteLength(content),
          durationSec: Math.round(lastEnd(cues) * 1000) / 1000,
        });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "captions.render",
    {
      description:
        "Burn captions onto a video and keep its audio. The HyperFrames engine (default) renders an animated " +
        "caption layer; the ffmpeg engine burns in an ASS overlay and needs no extra dependency. " +
        'Give it transcription segments, an SRT file, or a composition path (engine "hyperframes").',
      inputSchema: {
        ...sourceShape,
        composition: z.string().optional().describe("Path to a HyperFrames composition HTML (engine \"hyperframes\")"),
        input: z.string().min(1).describe("Path to the source video"),
        output: z.string().min(1).describe("Path of the rendered video"),
        engine: z.enum(["hyperframes", "ffmpeg"]).optional().describe('Rendering engine; default "hyperframes"'),
        width: z.number().int().min(16).optional().describe("Composition width (default: source width)"),
        height: z.number().int().min(16).optional().describe("Composition height (default: source height)"),
        fps: z.number().positive().optional().describe("Composition frame rate (default: source fps)"),
        overwrite: z.boolean().optional().describe("Replace the output file if it exists (default false)"),
      },
    },
    async ({
      transcript,
      srt,
      style,
      maxCharsPerLine,
      maxLines,
      composition,
      input: source,
      output,
      engine,
      width,
      height,
      fps,
      overwrite,
    }) => {
      try {
        const resolved = engine ?? "hyperframes";
        if (composition !== undefined && (transcript !== undefined || srt !== undefined)) {
          throw new Error("provide composition or a caption source, not both");
        }
        if (resolved === "ffmpeg" && composition !== undefined) {
          throw new Error('a composition needs engine "hyperframes"');
        }
        const cues =
          composition !== undefined
            ? undefined
            : await loadCues({ transcript, srt, style, maxCharsPerLine, maxLines });
        const result = await renderCaptions({
          input: source,
          output,
          engine: resolved,
          style,
          cues,
          compositionPath: composition,
          width,
          height,
          fps,
          overwrite,
        });
        return json(result);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}
