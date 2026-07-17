import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const session = `opencli-mcp-smoke-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "bin", "opencli-mcp.js")],
  stderr: "inherit",
});
const client = new Client({ name: "opencli-browser-smoke", version: "0.1.0" });

function assertOk(result, label) {
  if (result.isError) throw new Error(`${label} failed: ${JSON.stringify(result.content)}`);
  return result;
}

try {
  await client.connect(transport);
  const opened = assertOk(await client.callTool({
    name: "browser_open",
    arguments: { session, url: "https://example.com", window: "background" },
  }), "browser_open");
  const snapshot = assertOk(await client.callTool({
    name: "browser_snapshot",
    arguments: { session },
  }), "browser_snapshot");
  const title = assertOk(await client.callTool({
    name: "browser_get",
    arguments: { session, property: "title" },
  }), "browser_get");
  const screenshot = assertOk(await client.callTool({
    name: "browser_screenshot",
    arguments: { session, annotate: true },
  }), "browser_screenshot");

  const image = screenshot.content.find((item) => item.type === "image");
  if (!image || image.mimeType !== "image/png" || image.data.length < 100) {
    throw new Error("browser_screenshot did not return an MCP PNG image");
  }

  console.log(JSON.stringify({
    connected: true,
    session,
    open: opened.structuredContent,
    title: title.structuredContent,
    snapshotHasExampleDomain: JSON.stringify(snapshot.content).includes("Example Domain"),
    screenshotBase64Chars: image.data.length,
  }, null, 2));
} finally {
  try {
    await client.callTool({ name: "browser_close", arguments: { session } });
  } catch {}
  await client.close();
}
