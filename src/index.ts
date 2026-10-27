#!/usr/bin/env node
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: video-edit-mcp [--http] [--port 3333] [--host 127.0.0.1]");
} else if (args.includes("--http")) {
  await startHttp(Number(flag("--port") ?? 3333), flag("--host") ?? "127.0.0.1");
} else {
  await startStdio();
}
