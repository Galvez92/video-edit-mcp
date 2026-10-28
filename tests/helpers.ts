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
