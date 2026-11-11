import { createServer as createHttpServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "../server.js";

/** Minimal index page: this server's only UI-less endpoint is POST /mcp. */
const indexPage = (): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${SERVER_NAME}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.6">
<h1>${SERVER_NAME} ${SERVER_VERSION}</h1>
<p>Model Context Protocol server over Streamable HTTP. Everything runs locally: ffmpeg for media, a local Whisper backend for transcription.</p>
<p>Endpoint: <code>POST /mcp</code></p>
<p>Run <code>npx tsx src/index.ts --help</code> for CLI flags, or <code>npx tsx src/index.ts</code> for the stdio transport.</p>
</body>
</html>
`;

/** Stateless Streamable HTTP transport: one server+transport per request on POST /mcp. */
export function startHttp(port: number, host = "127.0.0.1"): Promise<Server> {
  const http = createHttpServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(indexPage());
      return;
    }
    if (!path.startsWith("/mcp")) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end((err as Error).message);
    }
  });
  return new Promise((resolve) =>
    http.listen(port, host, () => {
      console.error(`video-edit-mcp: listening on http://${host}:${port}/mcp`);
      resolve(http);
    }),
  );
}
