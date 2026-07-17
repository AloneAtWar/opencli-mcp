import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createOpenCliRunner, OpenCliError } from "./opencli-runner.js";
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
      appendLocator(args, input);
      appendOption(args, "--limit", input.limit);
      appendOption(args, "--text-max", input.text_max);
      appendTab(args, input.tab);
      return successResult(await run(args));
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
      if (input.target !== undefined && input.property !== "html") args.push(String(input.target));
      appendOption(args, "--selector", input.selector);
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
      },
    },
    wrap(async (input) => successResult(await run(buildActionArgs(input)))),
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
      return successResult(await run(args, { timeoutMs: timeout_ms + 10_000 }));
    }),
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
      return successResult(await run(args));
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
