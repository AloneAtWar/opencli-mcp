import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

export function startHttpServer(options = {}) {
  const host = options.host ?? process.env.OPENCLI_MCP_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.OPENCLI_MCP_PORT ?? 31999);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPENCLI_MCP_PORT: ${port}`);
  }
  if (host !== "127.0.0.1" && host !== "::1" && process.env.OPENCLI_MCP_ALLOW_REMOTE !== "1") {
    throw new Error("Refusing a non-loopback bind. Set OPENCLI_MCP_ALLOW_REMOTE=1 only if you add external authentication.");
  }

  const app = createMcpExpressApp({ host });
  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: "opencli-mcp", transport: "streamable-http" });
  });

  app.post("/mcp", async (req, res) => {
    const mcpServer = createServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      try { await transport.close(); } catch {}
      try { await mcpServer.close(); } catch {}
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", cleanup);
    } catch (error) {
      console.error(`[opencli-mcp-http] ${error.stack || error.message}`);
      await cleanup();
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed for stateless MCP transport" },
      id: null,
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed for stateless MCP transport" },
      id: null,
    });
  });

  const httpServer = app.listen(port, host, () => {
    console.error(`[opencli-mcp-http] listening on http://${host}:${port}/mcp`);
  });
  httpServer.on("error", (error) => {
    console.error(`[opencli-mcp-http] ${error.stack || error.message}`);
  });
  return httpServer;
}
