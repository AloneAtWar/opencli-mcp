import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const session = `opencli-flow-smoke-${Date.now()}`;
const client = new Client({ name: "opencli-flow-smoke", version: "0.1.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.OPENCLI_MCP_URL || "http://127.0.0.1:31999/mcp")));
  const tools = await client.listTools();
  for (const required of ["browser_flow", "browser_snapshot_compact"]) {
    if (!tools.tools.some((tool) => tool.name === required)) throw new Error(`missing ${required}`);
  }
  const flow = await client.callTool({
    name: "browser_flow",
    arguments: {
      session,
      intent: "Open Example Domain, follow Learn more, and verify the IANA page",
      max_steps: 6,
      max_total_ms: 30000,
      steps: [
        { id: "open", operation: "open", url: "https://example.com", window: "background", timeout_ms: 10000 },
        { id: "find", operation: "find", role: "link", name: "Learn more", limit: 5, save_as: "more", timeout_ms: 5000 },
        { id: "click", operation: "action", action: "click", target: "$more", timeout_ms: 5000 },
        { id: "wait", operation: "wait", type: "text", value: "IANA-managed Reserved Domains", timeout_ms: 15000 },
        { id: "title", operation: "get", property: "title", timeout_ms: 5000 },
        { id: "snapshot", operation: "snapshot", compact: true, max_chars: 6000, timeout_ms: 5000 },
      ],
    },
  });
  if (flow.isError || flow.structuredContent?.status !== "completed") throw new Error(JSON.stringify(flow.structuredContent));

  await client.callTool({ name: "browser_open", arguments: { session, url: "https://example.com", window: "background" } });
  const found = await client.callTool({ name: "browser_find", arguments: { session, role: "link", name: "Learn more", limit: 5 } });
  const ref = found.structuredContent?.entries?.[0]?.ref;
  const combinedAction = await client.callTool({
    name: "browser_action",
    arguments: {
      session,
      action: "click",
      target: ref,
      wait_for: { type: "text", value: "IANA-managed Reserved Domains", timeout_ms: 15000 },
      snapshot_after: { compact: true, max_chars: 6000 },
    },
  });
  if (combinedAction.isError || !String(combinedAction.structuredContent?.snapshot).includes("IANA")) {
    throw new Error(`combined action failed: ${JSON.stringify(combinedAction.structuredContent)}`);
  }
  const networkPage = await client.callTool({
    name: "browser_network",
    arguments: { session, all: true, limit: 1, offset: 0 },
  });
  if (networkPage.isError || (networkPage.structuredContent?.entries?.length ?? 0) > 1) {
    throw new Error(`network pagination failed: ${JSON.stringify(networkPage.structuredContent)}`);
  }

  console.log(JSON.stringify({
    connected: true,
    toolCount: tools.tools.length,
    status: flow.structuredContent.status,
    completedSteps: flow.structuredContent.completed_steps,
    elapsedMs: flow.structuredContent.elapsed_ms,
    savedRef: flow.structuredContent.variables?.more,
    lastHasIana: String(flow.structuredContent.last).includes("IANA"),
    combinedAction: {
      waited: Boolean(combinedAction.structuredContent?.wait),
      snapshotHasIana: String(combinedAction.structuredContent?.snapshot).includes("IANA"),
      snapshotCompacted: combinedAction.structuredContent?.snapshot_meta?.compacted,
    },
    networkPage: {
      returned: networkPage.structuredContent?.returned,
      totalEntries: networkPage.structuredContent?.total_entries,
      nextOffset: networkPage.structuredContent?.next_offset,
    },
    trace: flow.structuredContent.trace.map((step) => ({ id: step.id, status: step.status, elapsed_ms: step.elapsed_ms })),
  }, null, 2));
} finally {
  try { await client.callTool({ name: "browser_close", arguments: { session } }); } catch {}
  await client.close();
}
