import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

export const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

/** Fresh temp directory; the caller removes it. */
export const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "vem-"));

/** Generate the synthetic fixtures (scripts/make-fixtures.sh) into `dir`. */
export const makeFixtures = (dir: string): void => {
  execFileSync("bash", ["scripts/make-fixtures.sh", dir]);
};

export async function connectClient(): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

export interface ToolCall<T> {
  isError: boolean;
  text: string;
  data: T;
}

/** Call a tool and return its raw text plus the parsed JSON payload (undefined on error). */
export async function callTool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall<T>> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]?.text ?? "";
  const isError = res.isError === true;
  return { isError, text, data: isError ? (undefined as T) : (JSON.parse(text) as T) };
}

/** True when the call failed, whether the failure arrives as a tool error or a protocol error. */
export async function failed(call: Promise<ToolCall<unknown>>): Promise<boolean> {
  try {
    return (await call).isError;
  } catch {
    return true;
  }
}

/** Decode one RGB pixel of `file` at time `t` (seconds). */
export function pixelAt(file: string, t: number, x: number, y: number): [number, number, number] {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [buf[0]!, buf[1]!, buf[2]!];
}

/** HyperFrames producer + a headless Chrome it can launch. Set VEM_SKIP_HYPERFRAMES=1 to force-skip. */
export async function hyperframesReady(): Promise<boolean> {
  if (process.env.VEM_SKIP_HYPERFRAMES === "1" || !hasFfmpeg) return false;
  try {
    await import("@hyperframes/producer");
    const puppeteer = (await import("puppeteer")).default;
    const { existsSync } = await import("node:fs");
    return existsSync(await puppeteer.executablePath());
  } catch {
    return false;
  }
}

/** Minimal HyperFrames composition: the fixture clip full-frame with a red title band (y 90–138). */
export function titleComposition(clip: string | undefined, seconds = 2): string {
  const video = clip
    ? `<video id="bg" class="clip" src="${clip}" muted playsinline data-start="0" data-duration="${seconds}" data-track-index="0"></video>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:320px;height:240px;overflow:hidden}
#bg{position:absolute;top:0;left:0;width:320px;height:240px}
#title{position:absolute;top:90px;left:0;width:320px;height:48px;line-height:48px;text-align:center;font:bold 36px sans-serif;color:#fff;background:#c00}
</style></head><body>
<div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${seconds}" data-width="320" data-height="240">
  ${video}
  <div id="title" class="clip" data-start="0" data-duration="${seconds}" data-track-index="1">TITLE</div>
</div></body></html>
`;
}
