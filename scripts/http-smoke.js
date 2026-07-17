import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.OPENCLI_MCP_URL || "http://127.0.0.1:31999/mcp");
const client = new Client({ name: "opencli-http-smoke", version: "0.1.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(url));
  const tools = await client.listTools();
  const status = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });
  if (status.isError) throw new Error(JSON.stringify(status.content));
  console.log(JSON.stringify({
    connected: true,
    toolCount: tools.tools.length,
    opencliStatus: status.structuredContent,
  }, null, 2));
} finally {
  await client.close();
}
