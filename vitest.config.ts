import { defineConfig } from "vitest/config";
// Files run one at a time: ffmpeg encodes and the HyperFrames (Chrome) renders are CPU-heavy and
// time out when they compete on small runners.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], testTimeout: 60000, hookTimeout: 60000, fileParallelism: false } });
