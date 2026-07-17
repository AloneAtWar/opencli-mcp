import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createOpenCliRunner, OpenCliError } from "./opencli-runner.js";
import { executeCollect, executeFillSubmit, executeWaitAny } from "./browser-advanced.js";
import {
  buildSnapshotArgsForAction,
  buildWaitArgsForAction,
  compactSnapshotData,
  executeBrowserFlow,
  normalizeWaitData,
  paginateNetworkData,
  selectFindNth,
} from "./browser-flow.js";
import {
  appendFlag,
  appendLocator,
  appendOption,
  appendTab,
  assertAdapterName,
  browserArgs,
  buildActionArgs,
  normalizeSession,
  validateStringArray,
} from "./commands.js";

const sessionSchema = z.string().optional().describe("Stable OpenCLI browser session name. Reuse across calls; defaults to OPENCLI_MCP_SESSION or hermes-default.");
const tabSchema = z.string().optional().describe("Tab/page identity returned by browser_tabs or browser_open.");
const targetSchema = z.union([z.string(), z.number()]).optional().describe("Numeric ref from browser_snapshot/find, or a CSS selector.");
const locatorFields = {
  role: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  text_locator: z.string().optional().describe("Visible text semantic locator."),
  testid: z.string().optional(),
  nth: z.number().int().nonnegative().optional(),
};
const waitForSchema = z.object({
  type: z.enum(["selector", "text", "time", "xhr", "download"]),
  value: z.string().optional(),
  timeout_ms: z.number().int().positive().max(60_000).default(10_000),
  tab: tabSchema,
});
const snapshotAfterSchema = z.object({
  source: z.enum(["dom", "ax"]).default("dom"),
  compare_sources: z.boolean().default(false),
  compact: z.boolean().default(true),
  max_chars: z.number().int().min(2_000).max(100_000).default(12_000),
  max_lines: z.number().int().positive().max(5_000).default(500),
  omit_data_textareas: z.boolean().default(true),
  tab: tabSchema,
});
const waitAnyConditionSchema = z.object({
  type: z.enum(["url_contains", "title_contains", "selector", "text"]),
  value: z.string().min(1),
  tier: z.number().int().min(0).max(10).default(0).describe("Lower tier wins when multiple conditions match simultaneously. Use tier 0 for content-ready conditions, tier 1+ for fallbacks."),
});
const collectFieldSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  selector: z.string().optional(),
  property: z.enum(["text", "href", "src", "value", "html", "attribute"]).default("text"),
  attribute: z.string().regex(/^[A-Za-z_:][-A-Za-z0-9_:.]*$/).optional(),
});
const failureCaptureSchema = z.object({
  url: z.boolean().default(true),
  title: z.boolean().default(true),
  snapshot: z.boolean().default(true),
  source: z.enum(["dom", "ax"]).default("dom"),
  max_chars: z.number().int().min(2_000).max(20_000).default(6_000),
  max_lines: z.number().int().positive().max(1_000).default(300),
  omit_data_textareas: z.boolean().default(true),
  timeout_ms: z.number().int().positive().max(10_000).default(5_000),
});
const flowStepSchema = z.object({
  id: z.string().max(80).optional(),
  operation: z.enum(["open", "find", "action", "fill_submit", "wait", "wait_any", "snapshot", "get", "collect", "back"]),
  optional: z.boolean().default(false),
  retry: z.number().int().min(0).max(1).default(0),
  timeout_ms: z.number().int().positive().max(60_000).default(10_000),
  save_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  tab: tabSchema,
  url: z.string().optional(),
  window: z.enum(["foreground", "background"]).optional(),
  action: z.enum(["click", "hover", "focus", "dblclick", "check", "uncheck", "type", "fill", "select", "keys", "scroll", "upload", "drag"]).optional(),
  target: z.union([z.string(), z.number()]).optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  atomic: z.boolean().optional(),
  direction: z.enum(["up", "down"]).optional(),
  amount: z.number().int().positive().optional(),
  files: z.array(z.string()).optional(),
  source: z.union([z.enum(["dom", "ax"]), z.string(), z.number()]).optional(),
  destination: z.union([z.string(), z.number()]).optional(),
  from_nth: z.number().int().nonnegative().optional(),
  to_nth: z.number().int().nonnegative().optional(),
  from_role: z.string().optional(),
  from_name: z.string().optional(),
  to_role: z.string().optional(),
  to_name: z.string().optional(),
  css: z.string().optional(),
  ...locatorFields,
  limit: z.number().int().positive().max(500).optional(),
  text_max: z.number().int().positive().max(10_000).optional(),
  type: z.enum(["selector", "text", "time", "xhr", "download"]).optional(),
  conditions: z.array(waitAnyConditionSchema).min(1).max(8).optional(),
  poll_ms: z.number().int().min(100).max(2_000).optional(),
  discover: z.boolean().optional(),
  probe_selectors: z.array(z.string()).max(20).optional(),
  fallback_text: z.boolean().optional(),
  deduplicate_by: z.string().optional(),
  exclude: z.union([z.string(), z.object({
    title_contains: z.array(z.string()).optional(),
    href_contains: z.array(z.string()).optional(),
    text_contains: z.array(z.string()).optional(),
  })]).optional(),
  submit_strategy: z.enum(["form", "event", "both"]).optional(),
  property: z.enum(["title", "url", "text", "value", "attributes", "html"]).optional(),
  selector: z.string().optional(),
  fields: z.array(collectFieldSchema).min(1).max(20).optional(),
  required_fields: z.array(z.string()).max(20).optional(),
  offset: z.number().int().nonnegative().optional(),
  max_field_chars: z.number().int().min(100).max(20_000).optional(),
  as: z.enum(["html", "json"]).optional(),
  depth: z.number().int().positive().optional(),
  children_max: z.number().int().positive().optional(),
  compare_sources: z.boolean().optional(),
  compact: z.boolean().optional(),
  max_chars: z.number().int().min(2_000).max(100_000).optional(),
  max_lines: z.number().int().positive().max(5_000).optional(),
  omit_data_textareas: z.boolean().optional(),
});

function asJsonText(data) {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

function successResult(result, extra = {}) {
  const data = result.data ?? { ok: true };
  const structured = data && typeof data === "object" && !Array.isArray(data) ? data : { value: data };
  return {
    content: [{ type: "text", text: asJsonText(data) }],
    structuredContent: { ...structured, ...extra },
  };
}

function errorResult(error) {
  const details = error instanceof OpenCliError ? error.details : undefined;
  const payload = {
    error: {
      code: details?.data?.error?.code || details?.code || "OPENCLI_MCP_ERROR",
      message: error.message,
      hint: details?.data?.error?.hint,
    },
  };
  if (process.env.OPENCLI_MCP_DEBUG === "1") {
    payload.debug = {
      stderr: details?.stderr,
      exitCode: details?.code,
      invocation: details?.invocation,
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function wrap(handler) {
  return async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function createServer(options = {}) {
  const run = options.runOpenCli ?? createOpenCliRunner(options.runnerOptions);
  const server = new McpServer({ name: "opencli-mcp", version: "0.1.0" });

  server.registerTool(
    "opencli_status",
    {
      description: "Check the installed OpenCLI version, or run OpenCLI doctor to verify the Windows Chrome Browser Bridge.",
      inputSchema: {
        doctor: z.boolean().default(false),
      },
    },
    wrap(async ({ doctor }) => {
      const args = doctor ? ["doctor"] : ["--version"];
      return successResult(await run(args, { timeoutMs: doctor ? 120_000 : 30_000 }));
    }),
  );

  server.registerTool(
    "opencli_list",
    {
      description: "List installed OpenCLI site adapters and commands. Prefer an adapter before raw browser driving.",
      inputSchema: {},
    },
    wrap(async () => successResult(await run(["list", "-f", "json"]))),
  );

  server.registerTool(
    "opencli_run",
    {
      description: "Run a structured OpenCLI site adapter command. Arguments are passed as an array without shell interpolation.",
      inputSchema: {
        site: z.string(),
        command: z.string(),
        args: z.array(z.string()).default([]),
        format: z.enum(["json", "yaml", "plain", "md", "csv", "table"]).default("json"),
      },
    },
    wrap(async ({ site, command, args, format }) => {
      assertAdapterName(site, "site");
      assertAdapterName(command, "command");
      validateStringArray(args);
      return successResult(await run([site, command, ...args, "-f", format]));
    }),
  );

  server.registerTool(
    "browser_open",
    {
      description: "Open a URL in a persistent OpenCLI browser session backed by the logged-in Windows Chrome profile.",
      inputSchema: {
        url: z.string().url(),
        session: sessionSchema,
        window: z.enum(["foreground", "background"]).optional(),
        tab: tabSchema,
      },
    },
    wrap(async ({ url, session, window, tab }) => {
      const args = browserArgs(session, "open", url);
      appendOption(args, "--window", window);
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_bind",
    {
      description: "Bind or unbind the currently active real Chrome tab. Binding reuses the exact tab the user manually positioned and never closes it.",
      inputSchema: {
        action: z.enum(["bind", "unbind"]),
        session: sessionSchema,
      },
    },
    wrap(async ({ action, session }) => successResult(await run(browserArgs(session, action)))),
  );

  server.registerTool(
    "browser_snapshot",
    {
      description: "Inspect page state. Returns a bounded DOM or accessibility tree with numeric refs for subsequent actions.",
      inputSchema: {
        session: sessionSchema,
        source: z.enum(["dom", "ax"]).default("dom"),
        compare_sources: z.boolean().default(false),
        tab: tabSchema,
      },
    },
    wrap(async ({ session, source, compare_sources, tab }) => {
      const args = browserArgs(session, "state");
      if (source === "ax") args.push("--source", "ax");
      appendFlag(args, "--compare-sources", compare_sources);
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_snapshot_compact",
    {
      description: "Return a token-bounded page snapshot for unknown or noisy sites. Preserves refs while omitting data/style textareas and truncating with explicit omission metadata.",
      inputSchema: {
        session: sessionSchema,
        source: z.enum(["dom", "ax"]).default("dom"),
        compare_sources: z.boolean().default(false),
        max_chars: z.number().int().min(2_000).max(100_000).default(12_000),
        max_lines: z.number().int().positive().max(5_000).default(500),
        omit_data_textareas: z.boolean().default(true),
        tab: tabSchema,
      },
    },
    wrap(async ({ session, source, compare_sources, max_chars, max_lines, omit_data_textareas, tab }) => {
      const args = browserArgs(session, "state");
      if (source === "ax") args.push("--source", "ax");
      appendFlag(args, "--compare-sources", compare_sources);
      appendTab(args, tab);
      const result = await run(args);
      const compact = compactSnapshotData(result.data, {
        maxChars: max_chars,
        maxLines: max_lines,
        omitDataTextareas: omit_data_textareas,
      });
      return {
        content: [{ type: "text", text: asJsonText(compact.value) }],
        structuredContent: compact,
      };
    }),
  );

  server.registerTool(
    "browser_find",
    {
      description: "Find elements using a semantic locator or CSS and allocate stable OpenCLI refs.",
      inputSchema: {
        session: sessionSchema,
        css: z.string().optional(),
        ...locatorFields,
        limit: z.number().int().positive().max(500).default(50),
        text_max: z.number().int().positive().max(10000).default(120),
        tab: tabSchema,
      },
    },
    wrap(async (input) => {
      const args = browserArgs(input.session, "find");
      appendOption(args, "--css", input.css);
      appendLocator(args, { ...input, nth: undefined });
      appendOption(args, "--limit", input.limit);
      appendOption(args, "--text-max", input.text_max);
      appendTab(args, input.tab);
      const result = await run(args);
      result.data = selectFindNth(result.data, input.nth);
      return successResult(result);
    }),
  );

  server.registerTool(
    "browser_get",
    {
      description: "Read title, URL, element text/value/attributes, or bounded page HTML/JSON tree.",
      inputSchema: {
        property: z.enum(["title", "url", "text", "value", "attributes", "html"]),
        session: sessionSchema,
        target: targetSchema,
        selector: z.string().optional(),
        as: z.enum(["html", "json"]).optional(),
        depth: z.number().int().positive().optional(),
        children_max: z.number().int().positive().optional(),
        text_max: z.number().int().positive().optional(),
        ...locatorFields,
        tab: tabSchema,
      },
    },
    wrap(async (input) => {
      const args = browserArgs(input.session, "get", input.property);
      const positionalTarget = input.target ?? (input.property !== "html" ? input.selector : undefined);
      if (positionalTarget !== undefined && input.property !== "html") args.push(String(positionalTarget));
      if (input.property === "html") appendOption(args, "--selector", input.selector);
      appendOption(args, "--as", input.as);
      appendOption(args, "--depth", input.depth);
      appendOption(args, "--children-max", input.children_max);
      appendOption(args, "--text-max", input.text_max);
      appendLocator(args, input);
      appendTab(args, input.tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_collect",
    {
      description: "Collect repeated page items into structured records using bounded CSS selectors. Supports discover mode for unknown sites, fuzzy fallback, deduplication, and exclude filters.",
      inputSchema: {
        session: sessionSchema,
        selector: z.string().min(1).optional().describe("Root selector for repeated items/cards. Required unless discover=true."),
        fields: z.array(collectFieldSchema).min(1).max(20).optional(),
        required_fields: z.array(z.string()).max(20).default([]),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().max(100).default(20),
        max_field_chars: z.number().int().min(100).max(20_000).default(2_000),
        discover: z.union([z.boolean(), z.string()]).default(false).describe("When true, probe common repeated DOM patterns and return candidate selectors with sample data instead of collecting."),
        probe_selectors: z.array(z.string()).max(20).optional().describe("Custom selectors to try first in discover mode."),
        fallback_text: z.union([z.boolean(), z.string()]).default(true).describe("When a field selector returns empty, fall back to the root element's innerText."),
        deduplicate_by: z.string().optional().describe("Deduplicate results by this field name."),
        exclude: z.union([z.string(), z.object({
          title_contains: z.array(z.string()).optional(),
          href_contains: z.array(z.string()).optional(),
          text_contains: z.array(z.string()).optional(),
        })]).optional().describe("Filter out items matching any of these substring conditions. Accepts object or JSON string."),
        timeout_ms: z.number().int().positive().max(60_000).default(10_000),
        tab: tabSchema,
      },
    },
    wrap(async (input) => {
      if (typeof input.exclude === "string") {
        try { input.exclude = JSON.parse(input.exclude); } catch { input.exclude = undefined; }
      }
      input.discover = input.discover === true || input.discover === "true" || input.discover === "True";
      input.fallback_text = input.fallback_text === undefined || input.fallback_text === true || input.fallback_text === "true" || input.fallback_text === "True";
      return successResult(await executeCollect(run, { ...input, session: normalizeSession(input.session) }));
    }),
  );

  server.registerTool(
    "browser_action",
    {
      description: "Perform a structured browser interaction. Prefer refs from browser_snapshot/find and inspect again after navigation or SPA changes.",
      inputSchema: {
        action: z.enum(["click", "hover", "focus", "dblclick", "check", "uncheck", "type", "fill", "select", "keys", "scroll", "upload", "drag"]),
        session: sessionSchema,
        target: targetSchema,
        value: z.string().optional().describe("Text for type/fill, or option label/value for select."),
        key: z.string().optional(),
        direction: z.enum(["up", "down"]).optional(),
        amount: z.number().int().positive().optional(),
        files: z.array(z.string()).optional().describe("Windows-readable file paths for upload."),
        source: z.union([z.string(), z.number()]).optional(),
        destination: z.union([z.string(), z.number()]).optional(),
        from_nth: z.number().int().nonnegative().optional(),
        to_nth: z.number().int().nonnegative().optional(),
        from_role: z.string().optional(),
        from_name: z.string().optional(),
        to_role: z.string().optional(),
        to_name: z.string().optional(),
        ...locatorFields,
        tab: tabSchema,
        wait_for: waitForSchema.optional().describe("Optional bounded wait performed immediately after the action."),
        snapshot_after: snapshotAfterSchema.optional().describe("Optional snapshot returned after the action/wait, compacted by default."),
      },
    },
    wrap(async (input) => {
      const session = normalizeSession(input.session);
      const actionResult = await run(buildActionArgs({ ...input, session }));
      if (!input.wait_for && !input.snapshot_after) return successResult(actionResult);

      const combined = { action: actionResult.data };
      if (input.wait_for) {
        const timeout = input.wait_for.timeout_ms;
        const waitResult = await run(
          buildWaitArgsForAction(input.wait_for, session, input.tab),
          { timeoutMs: timeout + 5_000 },
        );
        combined.wait = normalizeWaitData(waitResult.data, input.wait_for.type, input.wait_for.value);
      }
      if (input.snapshot_after) {
        const snapshotResult = await run(buildSnapshotArgsForAction(input.snapshot_after, session, input.tab));
        if (input.snapshot_after.compact !== false) {
          const compact = compactSnapshotData(snapshotResult.data, {
            maxChars: input.snapshot_after.max_chars,
            maxLines: input.snapshot_after.max_lines,
            omitDataTextareas: input.snapshot_after.omit_data_textareas,
          });
          combined.snapshot = compact.value;
          combined.snapshot_meta = compact;
          delete combined.snapshot_meta.value;
        } else {
          combined.snapshot = snapshotResult.data;
        }
      }
      return {
        content: [{ type: "text", text: asJsonText(combined) }],
        structuredContent: combined,
      };
    }),
  );

  server.registerTool(
    "browser_fill_submit",
    {
      description: "Reliably fill a field and submit it in one MCP call by running fill → focus the same target → key press through official OpenCLI commands.",
      inputSchema: {
        session: sessionSchema,
        target: targetSchema,
        value: z.string().describe("Exact value to fill before submitting."),
        key: z.string().default("Enter"),
        atomic: z.boolean().default(true).describe("For CSS targets, set value and dispatch keyboard events in one page evaluation. Disable to use fill → focus → keys CLI fallback."),
        submit_strategy: z.enum(["form", "event", "both"]).default("form").describe("form: requestSubmit() if available. event: dispatch keyboard events only. both: dispatch events then try requestSubmit()."),
        ...locatorFields,
        timeout_ms: z.number().int().positive().max(60_000).default(15_000),
        tab: tabSchema,
      },
    },
    wrap(async (input) => {
      input.atomic = input.atomic === true || input.atomic === "true" || input.atomic === "True";
      input.submit_strategy = typeof input.submit_strategy === "string" ? input.submit_strategy : (input.submit_strategy ?? "form");
      return successResult(await executeFillSubmit(run, { ...input, session: normalizeSession(input.session) }));
    }),
  );

  server.registerTool(
    "browser_flow",
    {
      description: "Execute a short, bounded browser flow inside one MCP call. Steps run sequentially through the official OpenCLI CLI, stop on the first required failure, and return a partial trace. No loops; retries are capped at one.",
      inputSchema: {
        session: sessionSchema,
        intent: z.string().max(500).optional(),
        steps: z.array(flowStepSchema).min(1).max(20),
        max_steps: z.number().int().min(1).max(20).default(8),
        max_total_ms: z.number().int().min(1_000).max(120_000).default(30_000),
        on_error_capture: z.union([z.boolean(), failureCaptureSchema]).default(true).describe("Capture URL, title, and a compact snapshot after a required step fails."),
      },
    },
    wrap(async (input) => {
      const result = await executeBrowserFlow(run, input);
      return {
        content: [{ type: "text", text: asJsonText(result) }],
        structuredContent: result,
        isError: result.status !== "completed",
      };
    }),
  );

  server.registerTool(
    "browser_wait",
    {
      description: "Wait for selector, text, time, XHR URL regex, or Chrome download.",
      inputSchema: {
        type: z.enum(["selector", "text", "time", "xhr", "download"]),
        value: z.string().optional(),
        timeout_ms: z.number().int().positive().max(300000).default(10000),
        session: sessionSchema,
        tab: tabSchema,
      },
    },
    wrap(async ({ type, value, timeout_ms, session, tab }) => {
      const args = browserArgs(session, "wait", type);
      if (value !== undefined) args.push(value);
      appendOption(args, "--timeout", timeout_ms);
      appendTab(args, tab);
      const result = await run(args, { timeoutMs: timeout_ms + 10_000 });
      result.data = normalizeWaitData(result.data, type, value);
      return successResult(result);
    }),
  );

  server.registerTool(
    "browser_wait_any",
    {
      description: "Wait until any bounded URL, title, selector, or visible-text condition matches. Uses read-only page checks and returns the winning condition.",
      inputSchema: {
        session: sessionSchema,
        conditions: z.array(waitAnyConditionSchema).min(1).max(8),
        timeout_ms: z.number().int().positive().max(120_000).default(15_000),
        poll_ms: z.number().int().min(100).max(2_000).default(250),
        tab: tabSchema,
      },
    },
    wrap(async (input) => successResult(await executeWaitAny(run, { ...input, session: normalizeSession(input.session) }))),
  );

  server.registerTool(
    "browser_extract",
    {
      description: "Extract long-form page content as Markdown with continuation cursors.",
      inputSchema: {
        session: sessionSchema,
        selector: z.string().optional(),
        chunk_size: z.number().int().positive().max(100000).default(8000),
        start: z.number().int().nonnegative().default(0),
        tab: tabSchema,
      },
    },
    wrap(async ({ session, selector, chunk_size, start, tab }) => {
      const args = browserArgs(session, "extract");
      appendOption(args, "--selector", selector);
      appendOption(args, "--chunk-size", chunk_size);
      appendOption(args, "--start", start);
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_network",
    {
      description: "Inspect captured network requests as compact shapes or retrieve one full response body by cache key. Prefer this for API discovery.",
      inputSchema: {
        session: sessionSchema,
        detail: z.string().optional(),
        filter: z.string().optional(),
        all: z.boolean().default(false),
        raw: z.boolean().default(false),
        failed: z.boolean().default(false),
        since: z.string().optional(),
        until: z.string().optional(),
        max_body: z.number().int().nonnegative().optional(),
        ttl_ms: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(500).default(50).describe("Maximum request entries returned; use offset for pagination."),
        offset: z.number().int().nonnegative().default(0),
        tab: tabSchema,
      },
    },
    wrap(async (input) => {
      const args = browserArgs(input.session, "network");
      appendOption(args, "--detail", input.detail);
      appendOption(args, "--filter", input.filter);
      appendFlag(args, "--all", input.all);
      appendFlag(args, "--raw", input.raw);
      appendFlag(args, "--failed", input.failed);
      appendOption(args, "--since", input.since);
      appendOption(args, "--until", input.until);
      appendOption(args, "--max-body", input.max_body);
      appendOption(args, "--ttl", input.ttl_ms);
      appendTab(args, input.tab);
      const result = await run(args);
      if (input.detail || input.raw) return successResult(result);
      const paginated = paginateNetworkData(result.data, { limit: input.limit, offset: input.offset });
      return {
        content: [{ type: "text", text: asJsonText(paginated) }],
        structuredContent: paginated && typeof paginated === "object" ? paginated : { value: paginated },
      };
    }),
  );

  server.registerTool(
    "browser_console",
    {
      description: "Read recent browser console messages and JavaScript errors.",
      inputSchema: {
        session: sessionSchema,
        level: z.enum(["all", "error", "warning", "log", "info", "debug"]).default("all"),
        since: z.string().optional(),
        until: z.string().optional(),
        tab: tabSchema,
      },
    },
    wrap(async ({ session, level, since, until, tab }) => {
      const args = browserArgs(session, "console");
      appendOption(args, "--level", level);
      appendOption(args, "--since", since);
      appendOption(args, "--until", until);
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_screenshot",
    {
      description: "Take a viewport/full-page screenshot. Returns native MCP image content; annotate overlays OpenCLI ref labels.",
      inputSchema: {
        session: sessionSchema,
        full_page: z.boolean().default(false),
        annotate: z.boolean().default(false),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        tab: tabSchema,
      },
    },
    wrap(async ({ session, full_page, annotate, width, height, tab }) => {
      const args = browserArgs(session, "screenshot");
      appendFlag(args, "--full-page", full_page);
      appendFlag(args, "--annotate", annotate);
      appendOption(args, "--width", width);
      appendOption(args, "--height", height);
      appendTab(args, tab);
      const result = await run(args, { timeoutMs: 120_000 });
      const raw = typeof result.data === "string" ? result.data : result.stdout.trim();
      const base64 = raw.replace(/^data:image\/png;base64,/, "").replace(/\s+/g, "");
      const png = Buffer.from(base64, "base64");
      if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("OpenCLI screenshot did not return a valid PNG base64 payload");
      }
      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png" },
          { type: "text", text: JSON.stringify({ bytes: png.length, annotate, full_page }) },
        ],
        structuredContent: { bytes: png.length, annotate, full_page },
      };
    }),
  );

  server.registerTool(
    "browser_eval",
    {
      description: "Execute read-only JavaScript in the page or a listed cross-origin frame and return the value.",
      inputSchema: {
        javascript: z.string(),
        session: sessionSchema,
        frame: z.number().int().nonnegative().optional(),
        tab: tabSchema,
      },
    },
    wrap(async ({ javascript, session, frame, tab }) => {
      const args = browserArgs(session, "eval", javascript);
      appendOption(args, "--frame", frame);
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_frames",
    {
      description: "List iframe targets. Cross-origin frame indices can be passed to browser_eval.",
      inputSchema: { session: sessionSchema, tab: tabSchema },
    },
    wrap(async ({ session, tab }) => {
      const args = browserArgs(session, "frames");
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_tabs",
    {
      description: "List, create, select, or close tabs owned by an OpenCLI browser session.",
      inputSchema: {
        action: z.enum(["list", "new", "select", "close"]),
        session: sessionSchema,
        url: z.string().optional(),
        target_id: z.string().optional(),
      },
    },
    wrap(async ({ action, session, url, target_id }) => {
      const args = browserArgs(session, "tab", action);
      if (action === "new" && url) args.push(url);
      if ((action === "select" || action === "close") && target_id) args.push(target_id);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_dialog",
    {
      description: "Accept or dismiss a blocking JavaScript alert/confirm/prompt dialog.",
      inputSchema: {
        action: z.enum(["accept", "dismiss"]),
        prompt_text: z.string().optional(),
        session: sessionSchema,
        tab: tabSchema,
      },
    },
    wrap(async ({ action, prompt_text, session, tab }) => {
      const args = browserArgs(session, "dialog", action);
      appendOption(args, "--text", prompt_text);
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_back",
    {
      description: "Navigate the active or specified tab back in browser history.",
      inputSchema: { session: sessionSchema, tab: tabSchema },
    },
    wrap(async ({ session, tab }) => {
      const args = browserArgs(session, "back");
      appendTab(args, tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_close",
    {
      description: "Release an owned OpenCLI browser session tab lease. Use browser_bind action=unbind for a user-owned bound tab.",
      inputSchema: { session: sessionSchema },
    },
    wrap(async ({ session }) => successResult(await run(browserArgs(session, "close")))),
  );

  return server;
}

export async function startServer(options = {}) {
  const server = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
