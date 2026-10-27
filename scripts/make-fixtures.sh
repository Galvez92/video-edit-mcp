#!/usr/bin/env bash
# Generate synthetic test media with ffmpeg (no third-party footage).
set -euo pipefail
OUT="${1:-tests/fixtures}"
mkdir -p "$OUT"
command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc=size=320x240:rate=25:duration=2 \
  -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/testsrc.mp4"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i sine=frequency=220:sample_rate=48000:duration=2 "$OUT/tone.wav"
echo "fixtures written to $OUT"
