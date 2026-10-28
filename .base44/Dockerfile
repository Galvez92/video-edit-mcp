# Sandbox-only runtime image: Node plus ffmpeg/ffprobe for the dev preview and tests.
# Nothing from the repository is baked in: the source is bind-mounted at run time,
# so edits are picked up by the live-reloading dev command in docker-compose.base44.yml.
FROM node:22

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
