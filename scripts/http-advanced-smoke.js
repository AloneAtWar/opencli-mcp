import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const session = `xhs-advanced-smoke-${Date.now()}`;
const client = new Client({ name: "opencli-advanced-smoke", version: "0.1.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.OPENCLI_MCP_URL || "http://127.0.0.1:31999/mcp")));
  const tools = await client.listTools();
  for (const required of ["browser_fill_submit", "browser_wait_any", "browser_collect"]) {
    if (!tools.tools.some((tool) => tool.name === required)) throw new Error(`missing ${required}`);
  }

  const opened = await client.callTool({
    name: "browser_open",
    arguments: { session, url: "https://www.xiaohongshu.com", window: "background" },
  });
  if (opened.isError) throw new Error(JSON.stringify(opened.structuredContent));

  const submitted = await client.callTool({
    name: "browser_fill_submit",
    arguments: { session, target: "#search-input", value: "agent浏览器", key: "Enter", timeout_ms: 15000 },
  });
  if (submitted.isError) throw new Error(JSON.stringify(submitted.structuredContent));

  const waited = await client.callTool({
    name: "browser_wait_any",
    arguments: {
      session,
      timeout_ms: 20000,
      poll_ms: 250,
      conditions: [
        { type: "selector", value: "section a[href^='/search_result/']" },
        { type: "text", value: "一些agent浏览器自动化工具的个人评价" },
      ],
    },
  });
  if (waited.isError) throw new Error(JSON.stringify(waited.structuredContent));

  const collected = await client.callTool({
    name: "browser_collect",
    arguments: {
      session,
      selector: "section",
      limit: 20,
      required_fields: ["title", "href"],
      fields: [
        { name: "title", selector: "a[href^='/search_result/']:has(span)", property: "text" },
        { name: "href", selector: "a[href^='/search_result/']:has(span)", property: "href" },
        { name: "author", selector: "a[href^='/user/profile/']", property: "text" },
      ],
    },
  });
  if (collected.isError || (collected.structuredContent?.items?.length ?? 0) < 10) {
    throw new Error(`collect failed: ${JSON.stringify(collected.structuredContent)}`);
  }

  const failedFlow = await client.callTool({
    name: "browser_flow",
    arguments: {
      session,
      max_steps: 1,
      max_total_ms: 10000,
      on_error_capture: { max_chars: 3000, max_lines: 160 },
      steps: [{ id: "expected-failure", operation: "action", action: "click", target: "#definitely-not-present", timeout_ms: 2000 }],
    },
  });
  if (failedFlow.structuredContent?.status !== "stopped" || !failedFlow.structuredContent?.capture?.url || !failedFlow.structuredContent?.capture?.snapshot) {
    throw new Error(`failure capture missing: ${JSON.stringify(failedFlow.structuredContent)}`);
  }

  console.log(JSON.stringify({
    connected: true,
    toolCount: tools.tools.length,
    fillSubmit: {
      mode: submitted.structuredContent?.mode,
      filled: submitted.structuredContent?.filled,
      focusedAfterDispatch: submitted.structuredContent?.focused,
      eventsDispatched: submitted.structuredContent?.events_dispatched,
      formSubmitted: submitted.structuredContent?.form_submitted,
    },
    waitAny: waited.structuredContent,
    collect: {
      count: collected.structuredContent.count,
      firstTen: collected.structuredContent.items.slice(0, 10).map(({ title, author }) => ({ title, author })),
    },
    failureCapture: {
      status: failedFlow.structuredContent.status,
      url: failedFlow.structuredContent.capture.url,
      title: failedFlow.structuredContent.capture.title,
      snapshotChars: failedFlow.structuredContent.capture.snapshot.length,
    },
  }, null, 2));
} finally {
  try { await client.callTool({ name: "browser_close", arguments: { session } }); } catch {}
  await client.close();
}
