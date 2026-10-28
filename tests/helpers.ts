import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

export const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

export async function connectClient(): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

/** Shape of a tool call result as returned by the SDK client. */
export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

/** The text payload of a tool result. */
export const toolText = (result: unknown): string => (result as ToolResult).content[0].text;

/** The parsed JSON payload of a tool result. */
export const toolJson = (result: unknown): Record<string, unknown> =>
  JSON.parse(toolText(result)) as Record<string, unknown>;
