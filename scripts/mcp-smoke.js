import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "bin", "opencli-mcp.js")],
  stderr: "inherit",
  env: process.env,
});
const client = new Client({ name: "opencli-mcp-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length < 15) throw new Error(`Expected at least 15 tools, got ${tools.tools.length}`);
  const typed = tools.tools.filter((tool) => tool.name.startsWith("xiaohongshu_")).map((tool) => tool.name);
  if (typed.length) throw new Error(`Xiaohongshu media must go through opencli_run, found typed tools: ${typed.join(", ")}`);
  if (!tools.tools.some((tool) => tool.name === "opencli_run")) throw new Error("Missing tool: opencli_run");
  const imagesHelp = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "images", args: ["--help"] } });
  if (imagesHelp.isError) throw new Error(JSON.stringify(imagesHelp.content));
  const status = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });
  if (status.isError) throw new Error(JSON.stringify(status.content));
  const list = await client.callTool({ name: "opencli_adapter_list", arguments: {} });
  if (list.isError) throw new Error(JSON.stringify(list.content));
  const listed = list.structuredContent?.value;
  console.log(JSON.stringify({
    connected: true,
    toolCount: tools.tools.length,
    tools: tools.tools.map((tool) => tool.name),
    xiaohongshuImagesHelp: imagesHelp.structuredContent.help.split("\n")[0],
    opencliStatus: status.structuredContent,
    adapterEntries: Array.isArray(listed) ? listed.length : null,
  }, null, 2));
} finally {
  await client.close();
}
