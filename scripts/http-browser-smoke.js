import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const session = `opencli-http-smoke-${Date.now()}`;
const client = new Client({ name: "opencli-http-browser-smoke", version: "0.1.0" });
const assertOk = (result, label) => {
  if (result.isError) throw new Error(`${label}: ${JSON.stringify(result.content)}`);
  return result;
};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.OPENCLI_MCP_URL || "http://127.0.0.1:31999/mcp")));
  const opened = assertOk(await client.callTool({ name: "browser_open", arguments: { session, url: "https://example.com", window: "background" } }), "open");
  const snapshot = assertOk(await client.callTool({ name: "browser_snapshot", arguments: { session } }), "snapshot");
  const title = assertOk(await client.callTool({ name: "browser_get", arguments: { session, property: "title" } }), "title");
  const screenshot = assertOk(await client.callTool({ name: "browser_screenshot", arguments: { session, annotate: true } }), "screenshot");
  const image = screenshot.content.find((item) => item.type === "image");
  if (!image || image.data.length < 100) throw new Error("missing PNG image content");
  console.log(JSON.stringify({
    connected: true,
    open: opened.structuredContent,
    title: title.structuredContent,
    snapshotHasExampleDomain: JSON.stringify(snapshot.content).includes("Example Domain"),
    screenshotBase64Chars: image.data.length,
  }, null, 2));
} finally {
  try { await client.callTool({ name: "browser_close", arguments: { session } }); } catch {}
  await client.close();
}
