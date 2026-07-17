import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.env.ComSpec || "cmd.exe",
  args: ["/d", "/s", "/c", path.join(root, "start.cmd")],
  stderr: "inherit",
});
const client = new Client({ name: "start-cmd-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(JSON.stringify({ connected: true, toolCount: tools.tools.length }, null, 2));
} finally {
  await client.close();
}
