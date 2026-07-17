import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "bin", "opencli-mcp.js")],
  stderr: "inherit",
});
const client = new Client({ name: "opencli-mcp-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length < 15) throw new Error(`Expected at least 15 tools, got ${tools.tools.length}`);
  const status = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });
  if (status.isError) throw new Error(JSON.stringify(status.content));
  const list = await client.callTool({ name: "opencli_list", arguments: {} });
  if (list.isError) throw new Error(JSON.stringify(list.content));
  const listed = list.structuredContent?.value;
  console.log(JSON.stringify({
    connected: true,
    toolCount: tools.tools.length,
    tools: tools.tools.map((tool) => tool.name),
    opencliStatus: status.structuredContent,
    adapterEntries: Array.isArray(listed) ? listed.length : null,
  }, null, 2));
} finally {
  await client.close();
}
