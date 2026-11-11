#!/usr/bin/env node
/**
 * Test double for a local whisper.cpp CLI. It answers the `-h` probe like the real
 * binary (help text mentioning the JSON flags) and, for a real run, writes a canned
 * full-JSON transcript to `<prefix>.json` instead of decoding audio — so the whole
 * transcribe pipeline (ffmpeg extraction, spawn, JSON normalization) can be tested
 * without a model file or a Whisper install.
 */
import { writeFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write("usage: stub-whisper-cli -m MODEL -f WAV -of PREFIX [-l LANG] [-oj | -ojf]\n");
  process.stdout.write("  -oj,  --output-json       output result in JSON\n");
  process.stdout.write("  -ojf, --output-json-full  output result in JSON with timestamps\n");
  process.exit(0);
}

const prefix = value("-of");
if (!prefix) {
  process.stderr.write("stub-whisper-cli: missing -of PREFIX\n");
  process.exit(2);
}

const json = {
  systeminfo: "stub-whisper-cli",
  result: { language: "en" },
  transcription: [
    {
      offsets: { from: 0, to: 1200 },
      timestamps: { from: "00:00:00,000", to: "00:00:01,200" },
      text: " Hello world",
      tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
        { text: " Hello", offsets: { from: 100, to: 500 } },
        { text: " wor", offsets: { from: 500, to: 800 } },
        { text: "ld", offsets: { from: 800, to: 1000 } },
      ],
    },
    {
      offsets: { from: 1200, to: 2400 },
      timestamps: { from: "00:00:01,200", to: "00:00:02,400" },
      text: " Again",
      tokens: [{ text: " Again", offsets: { from: 1300, to: 2000 } }],
    },
  ],
};

writeFileSync(`${prefix}.json`, JSON.stringify(json));
process.stdout.write("stub-whisper-cli: wrote transcript\n");
