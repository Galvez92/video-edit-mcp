#!/usr/bin/env bash
# Generate synthetic test media with ffmpeg (no third-party footage).
set -euo pipefail
OUT="${1:-tests/fixtures}"
mkdir -p "$OUT"
command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
# Reference clip: 320x240 @ 25fps, 2s, stereo audio at 48 kHz.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc=size=320x240:rate=25:duration=2 \
  -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/testsrc.mp4"
# Audio-only fixture.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i sine=frequency=220:sample_rate=48000:duration=2 "$OUT/tone.wav"
# Deliberately different geometry, frame rate and sample rate (concat normalization).
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc=size=640x360:rate=30:duration=1 \
  -f lavfi -i sine=frequency=660:sample_rate=44100:duration=1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/testsrc-wide.mp4"
# Same geometry/frame rate as the reference clip, different pattern (stream-copy concat).
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=320x240:rate=25:duration=1 \
  -f lavfi -i sine=frequency=330:sample_rate=48000:duration=1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/testsrc-b.mp4"
# Video-only clip: no audio stream at all.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc=size=320x240:rate=25:duration=1 \
  -c:v libx264 -pix_fmt yuv420p "$OUT/silent.mp4"
echo "fixtures written to $OUT"
