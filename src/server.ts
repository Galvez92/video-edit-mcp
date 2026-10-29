import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { concat, cut, trim, type OnProgress } from "./core/edit.js";
import { health, probe } from "./core/ffmpeg.js";
import { loudnorm, measure, mix } from "./core/audiomix.js";
import { transcribe, whisperStatus } from "./core/whisper.js";
import { registerCaptionTools } from "./tools/captions.js";
import { registerReframeTool } from "./tools/reframe.js";
import { fail, json } from "./tools/result.js";
import { compose } from "./core/compose.js";
import { AUDIO_CURVES, TRANSITION_TYPES } from "./core/timeline.js";
import { LAYER_MOTIONS } from "./core/timelineRender.js";
import { exportPackage, PRESET_NAMES, render } from "./core/render.js";

const captionSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
});

const clipSchema = z.object({
  id: z.string().min(1),
  src: z.string().min(1),
  in: z.number().min(0),
  out: z.number().positive(),
  gainDb: z.number().optional(),
  startSec: z.number().min(0).optional().describe("Position on the timeline in seconds (default: right after the previous clip; gaps are black + silence)"),
  transition: z
    .object({
      type: z.enum(TRANSITION_TYPES),
      durationSec: z.number().positive(),
      curve: z.enum(AUDIO_CURVES).optional().describe("Audio crossfade curve, same on both sides (default linear; equal-power keeps loudness constant). Video unaffected"),
    })
    .optional()
    .describe("Transition from the previous clip into this one (clips overlap by durationSec). Audio tracks: crossfade/dissolve (overlapping fades)"),
  audioFade: z
    .object({ inSec: z.number().min(0).optional(), outSec: z.number().min(0).optional(), curve: z.enum(AUDIO_CURVES).optional() })
    .optional()
    .describe("Audio fade in/out of the clip (in+out must fit in the clip), with curve (default linear)"),
});
const motionSchema = z.object({ type: z.enum(LAYER_MOTIONS), durationSec: z.number().positive() });
const timelineSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  tracks: z.array(z.object({ id: z.string().min(1), kind: z.enum(["video", "audio", "caption"]), clips: z.array(clipSchema) })).min(1),
});

export const SERVER_NAME = "video-edit-mcp";
export const SERVER_VERSION = "0.1.0";

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
        "Encode a file or assemble a timeline with a fixed delivery preset: web-1080p (16:9), vertical-9x16, square (H.264+AAC, fit-and-pad) or audio-only (AAC .m4a). Optional alpha overlay / HyperFrames layers on top (timed, stacked by zIndex, positioned and sized keeping their aspect; off-frame layers are clamped and reported in warnings). Optional captions (SRT/VTT/cues/transcript) burned in after composition with HyperFrames or the ffmpeg fallback. Returns measured width/height/fps/codecs/bytes.",
      inputSchema: {
        input: z.string().min(1).optional().describe("Source media path (or pass timeline)"),
        timeline: timelineSchema.optional().describe("Timeline: first video track is the program (clips trimmed by in/out, placed by startSec or back-to-back, joined by transitions); audio tracks are mixed under it"),
        overlay: z.string().min(1).optional().describe("Alpha video (webm VP9 / mov ProRes 4444) composited over the program"),
        hyperframes: z.string().min(1).optional().describe("HyperFrames composition HTML rendered with alpha and composited over the program (needs the optional peer)"),
        layerStartSec: z.number().min(0).optional().describe("Program time where the overlay/HyperFrames layer starts (default 0)"),
        layerDurationSec: z.number().positive().optional().describe("How long the layer is shown (default: until the layer ends)"),
        layers: z
          .array(
            z.object({
              overlay: z.string().min(1).optional().describe("Alpha video file"),
              hyperframes: z.string().min(1).optional().describe("HyperFrames composition HTML"),
              startSec: z.number().min(0).optional().describe("Program time where the layer starts (default 0)"),
              durationSec: z.number().positive().optional().describe("How long it is shown (default: until it ends)"),
              zIndex: z.number().optional().describe("Stacking order, higher on top (default: array order)"),
              x: z.number().min(0).optional().describe("Left position in output pixels (default 0)"),
              y: z.number().min(0).optional().describe("Top position in output pixels (default 0)"),
              scale: z.number().positive().max(10).optional().describe("Uniform size, source aspect kept. scaleMode frame-width (default): layer width = scale × frame width, (0,1]. native: scale × source pixel size, (0,10]"),
              scaleMode: z.enum(["frame-width", "native"]).optional().describe("How scale is measured (default frame-width)"),
              width: z.number().min(2).optional().describe("Layer width in px; alone keeps the source aspect"),
              height: z.number().min(2).optional().describe("Layer height in px; alone keeps the source aspect; with width = explicit box (see fit)"),
              fit: z.enum(["contain", "cover", "stretch"]).optional().describe("How the source fills an explicit width+height box (default contain: fit inside, centred, keeps aspect; cover: fill and crop; stretch: exact box, distorts). With no size the layer fills the frame (default stretch)"),
              fadeInSec: z.number().positive().optional().describe("Alpha fade-in at the layer start (s)"),
              fadeOutSec: z.number().positive().optional().describe("Alpha fade-out before the layer end (s); needs durationSec; fadeIn+fadeOut must fit"),
              enter: motionSchema.optional().describe("Entry motion: slide-left/right/up/down from off-frame, or scale up from zero"),
              exit: motionSchema.optional().describe("Exit motion off-frame or scale down to zero; needs durationSec"),
            }),
          )
          .optional()
          .describe("Several layers (exactly one of overlay/hyperframes each), composited bottom to top; combinable with the legacy overlay/hyperframes params (those become the first layer)"),
        captions: z
          .object({
            srt: z.string().min(1).optional().describe("Path to an .srt file (a .vtt path is detected and parsed as WebVTT)"),
            vtt: z.string().min(1).optional().describe("Path to a WebVTT file"),
            cues: z
              .array(z.object({ start: z.number().min(0), end: z.number().positive(), text: z.string().optional(), lines: z.array(z.string()).optional() }))
              .optional()
              .describe("Inline cues in program seconds; text (newlines split lines) or pre-wrapped lines"),
            transcript: z
              .union([z.array(captionSegmentSchema), z.object({ segments: z.array(captionSegmentSchema) }).passthrough(), z.string().min(1)])
              .optional()
              .describe("Transcription segments, the transcribe tool's output object, or a path to a JSON file of either"),
            style: z.enum(["plain", "karaoke", "pop", "box"]).optional().describe('Caption style (default "plain"); karaoke needs word timings'),
            maxCharsPerLine: z.number().int().min(8).optional().describe("Transcript wrapping limit per line (default 42)"),
            maxLines: z.number().int().min(1).optional().describe("Transcript lines per caption chunk (default 2)"),
            engine: z.enum(["auto", "hyperframes", "ffmpeg"]).optional().describe('Burn-in engine: auto (default) = HyperFrames when installed, else ffmpeg/libass'),
            srtOutput: z.string().min(1).optional().describe("Where to write the SRT of the burned cues (default: output path with .srt)"),
          })
          .optional()
          .describe("Captions burned in after composition (times are program seconds). Exactly one of srt/vtt/cues/transcript. Video presets only. The SRT used is written next to the output and picked up by export.package"),
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
        subtitles: z.string().min(1).optional().describe("Optional .srt file, stored as captions.srt (default: the render's sidecar <video>.srt, if present)"),
        sidecarCaptions: z.boolean().optional().describe("When subtitles is omitted, include the sidecar <video>.srt written by render captions (default true)"),
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
        composition: z.string().min(1).describe("HyperFrames composition HTML file, or a project directory with index.html"),
        output: z.string().min(1).describe("Output video path"),
        fps: z.number().int().positive().optional().describe("Frame rate (default 30); canvas size comes from the composition"),
        format: z.enum(["mp4", "webm", "mov"]).optional().describe("mp4 opaque, webm/mov with alpha (default from extension)"),
        quality: z.enum(["draft", "standard", "high"]).optional(),
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
  registerCaptionTools(server);
  registerReframeTool(server);

  return server;
}
