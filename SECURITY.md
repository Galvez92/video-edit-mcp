# Security policy

## Supported versions
Only `main` is supported.

## Reporting a vulnerability
Use GitHub → **Security → Report a vulnerability** (private reporting). Please do not open public issues for security problems. We aim to respond within 7 days.

## Deployment notes
- The MCP server has **no built-in authentication**. The stdio transport is meant for local use. If you expose it over HTTP, put it behind a reverse proxy that enforces a token (e.g. bearer auth) and TLS, and never expose it directly to the internet.
- Tools read and write local media paths and invoke ffmpeg; run it with least privilege and restrict the working directories it can access.
