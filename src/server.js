import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { createXiaohongshuMedia, describeMediaCache } from "./xiaohongshu-media.js";
import { summarizeFailure } from "./cli-failure.js";
import {
  createOpenCliRunner,
  describeOpenCliCandidates,
  OpenCliError,
  resolveOpenCli,
} from "./opencli-runner.js";
import { createSiteGate } from "./site-gate.js";
import { executeCollect, executeFillSubmit, executeWaitAny, executeOpen, executeRead } from "./browser-advanced.js";
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
import { deepWellFormed } from "./text-safe.js";

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
  window: z.enum(["foreground", "background"]).default("background"),
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
  auto_scroll_retry: z.union([z.boolean(), z.string()]).optional(),
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
  // Non-CLI failures (the per-site gate, for example) carry their own MCP error
  // contract, so they are forwarded as-is instead of being squeezed through the
  // CLI failure summary.
  if (error?.mcpError) {
    const payload = { error: error.mcpError };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }
  const details = error instanceof OpenCliError ? error.details : undefined;
  const summary = summarizeFailure(error);
  const payload = {
    error: {
      code: summary.code,
      message: summary.message,
      ...(summary.hint === undefined ? {} : { hint: summary.hint }),
      ...(summary.cli_error_code === undefined ? {} : { cli_error_code: summary.cli_error_code }),
      ...(summary.exit_code === undefined ? {} : { exit_code: summary.exit_code }),
      ...(summary.stderr_tail === undefined ? {} : { stderr_tail: summary.stderr_tail }),
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

// P2 observability: report which discovery path resolved the OpenCLI CLI. Never throws, so a
// resolution failure degrades to extra diagnostics instead of breaking the tool call.
function resolutionExtra(env, cwd) {
  try {
    const resolved = resolveOpenCli(env, { cwd });
    return {
      resolution: {
        command: resolved.command,
        prefixArgs: resolved.prefixArgs,
        source: resolved.source,
      },
    };
  } catch (error) {
    const extra = { resolutionError: error.message };
    try {
      extra.resolutionCandidates = describeOpenCliCandidates(env, { cwd });
    } catch {
      // Candidate probing is best-effort diagnostics only.
    }
    return extra;
  }
}

function wrap(handler) {
  return async (input) => {
    try {
      return wellFormedResult(await handler(input));
    } catch (error) {
      return wellFormedResult(errorResult(error));
    }
  };
}

function mediaCacheToolSummary(cache) {
  if (cache?.error) {
    return `- Cache: effective values are unavailable (${cache.error}); call opencli_status for the running MCP process.`;
  }
  const megabytes = cache.download_cache_max_mb;
  return `- Cache: effective for this MCP process: OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB=${megabytes} (${megabytes * 1000000}-byte soft budget); when exceeded, oldest unprotected task directories are evicted FIFO by creation time. OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES=${cache.image_cache_max_files} applies only to the images cache and prunes oldest files by mtime. Active, current and quarantined tasks are protected. Later calls can evict earlier files, so copy out anything you need to keep.`;
}

// Last line of defence for the response the host receives. A lone surrogate
// anywhere in a tool result - page text, CLI JSON, or an echo of the caller's
// own arguments - makes the peer reject the whole JSON body with HTTP 400, which
// kills the MCP session. Truncation sites should not create them, but they can
// also arrive from upstream (OpenCLI truncates page text by code unit too), so
// every tool result is normalized on the way out.
//
// The sanitizer must never fail a call that would otherwise succeed: if it
// throws for any reason, the original result is returned untouched.
function wellFormedResult(result) {
  try {
    return deepWellFormed(result);
  } catch (error) {
    // The sanitizer must never fail a call that would otherwise succeed, but a
    // silent failure means the peer can still kill the session on this payload.
    if (process.env.OPENCLI_MCP_DEBUG === "1") {
      process.stderr.write(`[opencli-mcp] well-formed normalization failed: ${error?.message ?? error}\n`);
    }
    return result;
  }
}

// Media subcommands handled by this MCP server rather than passed through. They
// ride along with the adapter catalog so a caller that only reads this tool can
// still find them; the adapter array itself stays CLI-only.
const MCP_HANDLED_SUBCOMMANDS = [
  {
    tool: "opencli_run",
    site: "xiaohongshu",
    command: "download",
    cli_command: "xiaohongshu/download",
    handled_by_mcp: true,
    description: "Wrap the existing CLI download with a managed cache, verified paths and media failure reporting.",
    args: '["<note-url>", "--output", "<dir>", "--timeout-ms", "60000"]',
  },
  {
    tool: "opencli_run",
    site: "xiaohongshu",
    command: "images",
    cli_command: null,
    mcp_only: true,
    description: "Return one note's images as native MCP ImageContent.",
    args: '["<note-url>", "--indexes", "1,3", "--timeout-ms", "60000"]',
  },
];

export function createServer(options = {}) {
  const run = options.runOpenCli ?? createOpenCliRunner(options.runnerOptions);
  const mediaEnv = options.runnerOptions?.env ?? process.env;
  const mediaCwd = options.runnerOptions?.cwd ?? process.cwd();
  const effectiveMediaCache = describeMediaCache(mediaEnv, mediaCwd);
  const effectiveImageBlocks = Number.isSafeInteger(effectiveMediaCache.image_blocks_per_response)
    ? `${effectiveMediaCache.image_blocks_per_response} image block(s) per response for this MCP process`
    : "the configured number of image blocks per response";
  // Cross-call pacing: each CLI invocation paces itself, but only a shared gate
  // keeps that pacing effective when a caller fires several calls at once.
  const siteGate = options.siteGate ?? createSiteGate({ env: options.runnerOptions?.env ?? process.env });
  const xiaohongshu = createXiaohongshuMedia({
    run,
    env: mediaEnv,
    cwd: mediaCwd,
  });
  const server = new McpServer({ name: "opencli-mcp", version: "0.1.0" });
  // Opt-in tool-call trace: OPENCLI_MCP_TRACE_CALLS=<file> appends one JSONL line
  // per call with the tool name and argument names. Values are never written, so
  // a password, cookie or page snippet cannot leak into the trace file. Off by
  // default; never breaks a call if writing fails.
  const traceFile = (options.runnerOptions?.env ?? process.env).OPENCLI_MCP_TRACE_CALLS?.trim();
  if (traceFile) {
    const register = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) => register(name, config, async (input) => {
      try {
        const argNames = input && typeof input === "object" ? Object.keys(input).sort() : [];
        await appendFile(traceFile, `${JSON.stringify({ ts: new Date().toISOString(), tool: name, arg_names: argNames })}\n`);
      } catch { /* Tracing is diagnostic only. */ }
      return handler(input);
    });
  }

  server.registerTool(
    "opencli_status",
    {
      description: "Check the installed OpenCLI version, or run OpenCLI doctor to verify the Windows Chrome Browser Bridge. Also reports the effective OpenCLI resolution, Xiaohongshu media-cache limits, and site-gate configuration for this MCP process.",
      inputSchema: {
        doctor: z.boolean().default(false),
      },
    },
    wrap(async ({ doctor }) => {
      const args = doctor ? ["doctor"] : ["--version"];
      const env = mediaEnv;
      const extra = {
        ...resolutionExtra(env, mediaCwd),
        media_cache: describeMediaCache(env, mediaCwd),
        // Status keeps the same snake_case contract as media_cache; the busy map
        // is normally empty and exists for diagnosing queueing.
        site_gate: {
          concurrency: siteGate.config.concurrency,
          queue_max: siteGate.config.queueMax,
          queue_wait_ms: siteGate.config.queueWaitMs,
          busy: siteGate.snapshot(),
        },
      };
      try {
        return successResult(await run(args, { timeoutMs: doctor ? 120_000 : 30_000 }), extra);
      } catch (error) {
        const failure = errorResult(error);
        failure.structuredContent = { ...failure.structuredContent, ...extra };
        return failure;
      }
    }),
  );

  server.registerTool(
    "opencli_adapter_list",
    {
      description: "Search the installed OpenCLI CLI site adapter catalog by keyword(s). Matches against site, command, name, description, and domain. Returns filtered results with full per-adapter metadata, without returning the full adapter list for targeted lookups. This catalog contains CLI adapters only. The official xiaohongshu/download adapter appears here; when called through opencli_run it is intercepted and wrapped with a managed cache and verified paths. The MCP-only xiaohongshu images subcommand has no CLI equivalent and never appears here. The result also carries mcp_handled_subcommands, which describes the MCP semantics of both entry points so a caller that only reads the adapter array still finds them.",
      inputSchema: {
        keywords: z.array(z.string()).optional().describe("Keywords to filter adapters. All keywords must match (AND logic). Each keyword is checked against site, name, command, description, and domain (case-insensitive). Omit to return all adapters."),
        limit: z.number().int().positive().max(500).default(50).describe("Maximum number of adapters to return."),
      },
    },
    wrap(async ({ keywords, limit }) => {
      const result = await run(["list", "-f", "json"]);
      let adapters = result.data;
      if (!Array.isArray(adapters)) {
        return successResult(result);
      }
      if (Array.isArray(keywords) && keywords.length > 0) {
        const normalized = keywords.map((kw) => kw.toLowerCase());
        adapters = adapters.filter((adapter) => {
          const haystack = [
            adapter.site,
            adapter.name,
            adapter.command,
            adapter.description,
            adapter.domain,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return normalized.every((kw) => haystack.includes(kw));
        });
      }
      if (adapters.length > limit) {
        adapters = adapters.slice(0, limit);
      }
      return {
        content: [
          { type: "text", text: asJsonText(adapters) },
          { type: "text", text: asJsonText({ mcp_handled_subcommands: MCP_HANDLED_SUBCOMMANDS, note: "These opencli_run subcommands are handled by this MCP server. download wraps the existing xiaohongshu/download CLI command; images is MCP-only and has no CLI equivalent." }) },
        ],
        structuredContent: { value: adapters, total: adapters.length, mcp_handled_subcommands: MCP_HANDLED_SUBCOMMANDS },
      };
    }),
  );

  server.registerTool(
    "opencli_run",
    {
      description: "Run a structured OpenCLI site adapter command: site, command, args (argv, never a shell string), format. For every site except Xiaohongshu media the site/command pair must exist in the CLI adapter catalog (see opencli_adapter_list) and the call is passed straight through to the OpenCLI CLI.\n\nXiaohongshu media adds two subcommands to this tool. command=download intercepts the existing xiaohongshu/download CLI command and wraps it with a managed cache, verified paths and media failure reporting; it is not a new CLI command. command=images is implemented by this MCP server, has no CLI equivalent, and is not a CLI adapter. Both replace the former xiaohongshu_download / xiaohongshu_images tools. Pick by what the caller needs: choose download when a server-side consumer (OCR, ffmpeg, upload, further processing) needs real file paths or when the note has video; choose images when the model itself needs to look at the pictures. The generic format argument is ignored by both media subcommands: the wrapper always parses the CLI output as JSON internally so it can see per-media failures.\n\ndownload - args=[note_url, \"--output\", dir?, \"--timeout-ms\", \"60000\"]:\n- Downloads every media file of one note into the server-local managed cache and returns verified absolute server-local paths (never guessed from CLI stdout).\n- Result: status success|partial|error, path_scope=server_local, server_platform, managed_cache, download_root, output_directory, directory_source, inventory_complete, cli_result, and files[] with local_path, size_bytes, and a MIME type sniffed from the bytes on disk.\n- Root precedence: --output > OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR > the server user's OS Downloads folder.\n- A partial download still returns every file it verified. Whenever status is not success the result also carries error {code, message, failed_indexes?}: code CLI_ERROR means the CLI process itself failed or timed out and also carries cli_error_code, exit_code when numeric, and a bounded stderr_tail when it differs from the message; code MEDIA_DOWNLOAD_FAILED means the CLI exited 0 but one or more media rows failed and message quotes the first CLI reason. errors[] only reports cleanup problems (CLEANUP_PENDING, each with a message); the full per-item rows stay in cli_result. inventory_complete=false means a timeout or output limit stopped the inventory, so treat files[] as partial.\n\nimages - args=[note_url, \"--indexes\", \"1,3\", \"--timeout-ms\", \"60000\"]:\n- Reuses the same managed download, then returns the images directly to the model as native MCP ImageContent. There is no output argument, and the images success payload carries no local paths; a CLI failure message may still quote a server path, because paths are diagnostics rather than secrets.\n- args=[\"--help\"] prints the exact argument set. --indexes takes a comma-separated list of 1-based original media indices; --index is also accepted and repeatable; omit both to return every image.\n- Indices come from the CLI's on-disk filenames <note-id>_<n>.<ext> and cover every downloaded media item including videos, but videos are never returned as images, so a note with video can have no image at index 1. Index mapping and image/video classification are never guessed or renumbered.\n- Response caps: one image block per response by default, because a host that cannot render several can drop the whole result (raise OPENCLI_XIAOHONGSHU_IMAGE_BLOCKS_PER_RESPONSE, max 20); extra requested indexes are listed in skipped_indexes and can be fetched with another --indexes call. Byte caps stay at 10 MiB each and 20 MiB total. The CLI may still download the whole note first, so these caps bound the response, not the download traffic or disk peak. The MIME type is sniffed from the real bytes, not the filename suffix.\n- Errors: status is success, partial or error; a top-level error {code, message, index?, available_indexes?, cli_error_code?, exit_code?} is added whenever status is not success, and available_indexes always lists the 1-based indexes that actually exist on disk for this note, plus note_id when the download produced exactly one note id. Read error.code and error.message first, then retry with an index from available_indexes; per-item detail stays in errors[] where every entry carries a human message and, when the CLI reported one, its own reason in detail. Codes: CLI_ERROR (the CLI's real message is quoted, e.g. a risk-control or empty-result message), IMAGE_DOWNLOAD_FAILED, IMAGE_NOT_FOUND (message names the available indexes), IMAGE_LIMIT, IMAGE_READ_FAILED, IMAGE_INDEX_UNMAPPABLE, IMAGE_INDEX_AMBIGUOUS, NO_IMAGES, TERMINATION_UNCONFIRMED, CLEANUP_PENDING. The CLI currently packs a per-item reason into its row's size text instead of a structured field, so per-item codes are assigned by this server.\n\nBoth subcommands:\n- note_url must be the full note URL carrying its xsec_token (https://www.xiaohongshu.com/explore/<id>?xsec_token=...) or an xhslink.com short link. Take it from the url field of search/feed rows or the user's share link; never invent, guess or strip the token.\n- They run on the MCP server host, not the client: results are server-local (path_scope=server_local, server_platform reports the OS) and a remote client cannot open those paths unless it shares that filesystem.\n- Both share one managed cache: OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB (default 100; 1 MB = 1,000,000 bytes) budgets the whole managed tree and reclaims oldest-first, and OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES (default 10) prunes the image cache oldest-first. Later calls can evict earlier files, so copy out anything you need to keep.\n- The xsec_token, cookies and other credentials are redacted from cli_result and from every error message, while server-local paths are kept when they explain a failure.\n\nConcurrency: calls for the same site are limited to OPENCLI_MCP_SITE_CONCURRENCY (default 1) at a time; up to OPENCLI_MCP_SITE_QUEUE_MAX (default 8) extra calls wait, each for at most OPENCLI_MCP_SITE_QUEUE_WAIT_MS (default 30000). A call that cannot get in fails with error.code SITE_BUSY instead of stacking more requests against the site: wait for the running call, then retry. Calls for different sites never queue behind each other.\n\nRetries: the Xiaohongshu media subcommands replay a single \"Navigation rejected.\" failure (a Chrome tab race, not platform risk control) once with the opposite OPENCLI_SITE_SESSION mode (ephemeral or persistent), and report it in retry {reason, attempts, session, outcome}. Every other failure, and every other adapter command, is never retried automatically by this wrapper.\n\nHosts cache a snapshot of tools/list: calls always reach this live server, but new tools, renamed tools and edited descriptions only appear after the host app/connector is refreshed (for ChatGPT apps: the Refresh action in the app or connector settings; as a last resort remove and re-add the connector). Restarting this MCP server, the tunnel, or the host app does not refresh that snapshot.".replace(
        "- Both share one managed cache: OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB (default 100; 1 MB = 1,000,000 bytes) budgets the whole managed tree and reclaims oldest-first, and OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES (default 10) prunes the image cache oldest-first. Later calls can evict earlier files, so copy out anything you need to keep.",
        mediaCacheToolSummary(effectiveMediaCache),
      ).replace(
        "Response caps: one image block per response by default",
        `Response caps: ${effectiveImageBlocks}`,
      ),
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
      return siteGate.run(site, async () => {
        if (site === "xiaohongshu" && command === "download") {
          return xiaohongshu.runDownload(args, { format });
        }
        if (site === "xiaohongshu" && command === "images") {
          return xiaohongshu.runImages(args, { format });
        }
        return successResult(await run([site, command, ...args, "-f", format]));
      });
    }),
  );

  server.registerTool(
    "browser_open",
    {
      description: "Open a URL in a persistent OpenCLI browser session backed by the logged-in Windows Chrome profile.",
      inputSchema: {
        url: z.string().url(),
        session: sessionSchema,
        window: z.enum(["foreground", "background"]).default("background"),
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
      description: "Read page state: title, URL, input value, or element attributes. For content extraction (text/html), use browser_read instead.",
      inputSchema: {
        property: z.enum(["title", "url", "value", "attributes"]),
        session: sessionSchema,
        target: targetSchema,
        selector: z.string().optional(),
        ...locatorFields,
        tab: tabSchema,
      },
    },
    wrap(async (input) => {
      const args = browserArgs(input.session, "get", input.property);
      const positionalTarget = input.target ?? input.selector;
      if (positionalTarget !== undefined) args.push(String(positionalTarget));
      appendLocator(args, input);
      appendTab(args, input.tab);
      return successResult(await run(args));
    }),
  );

  server.registerTool(
    "browser_read",
    {
      description: "Extract content from the page as text | html. The target may be a numeric ref from browser_snapshot/browser_find or a CSS selector. For long-form page content or Markdown, use browser_extract instead. Supports auto-scroll retry for lazily-loaded elements. Returns diagnosis on failure.",
      inputSchema: {
        property: z.enum(["text", "html"]).default("text"),
        session: sessionSchema,
        target: targetSchema,
        selector: z.string().optional().describe("CSS selector for the target element. Alias for target; if both are omitted, reads the entire page."),
        nth: z.number().int().nonnegative().optional(),
        auto_scroll_retry: z.union([z.boolean(), z.string()]).default(true).describe("If element not found, auto-scroll and retry once."),
        timeout_ms: z.number().int().positive().max(60_000).default(10_000),
        tab: tabSchema,
      },
    },
    wrap(async (input) => {
      input.auto_scroll_retry = input.auto_scroll_retry === true || input.auto_scroll_retry === "true";
      return successResult(await executeRead(run, { ...input, session: normalizeSession(input.session) }));
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
  startPreflight(options);
  return server;
}

const PREFLIGHT_TIMEOUT_MS = 20_000;

// P2 startup self-check: resolve the CLI and probe `--version` once so a broken discovery path is
// visible in the host logs before the first tool call. Fire-and-forget: it never blocks the MCP
// handshake, never writes to stdout (stdout carries MCP frames), and never throws.
function startPreflight(options) {
  if (options.preflight === false || process.env.OPENCLI_MCP_SKIP_PREFLIGHT === "1") return;

  void (async () => {
    const env = options.runnerOptions?.env ?? process.env;
    const cwd = options.runnerOptions?.cwd ?? process.cwd();
    let resolved;
    try {
      resolved = resolveOpenCli(env, { cwd });
    } catch (error) {
      process.stderr.write(
        `[opencli-mcp] preflight failed: ${error.message} | fix: set OPENCLI_MCP_BIN to the OpenCLI ` +
          `executable (plus OPENCLI_MCP_PREFIX_ARGS when needed), or install OpenCLIApp` +
          `${describeCandidatesSuffix(env, cwd)}\n`,
      );
      return;
    }

    const invocation = `${resolved.command} ${resolved.prefixArgs.join(" ")}`.trim();
    try {
      const run = options.runOpenCli ?? createOpenCliRunner(options.runnerOptions);
      const result = await withTimeout(
        run(["--version"], { timeoutMs: PREFLIGHT_TIMEOUT_MS }),
        PREFLIGHT_TIMEOUT_MS,
      );
      process.stderr.write(
        `[opencli-mcp] preflight ok: ${describeVersion(result)} | command: ${invocation} | source: ${resolved.source}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `[opencli-mcp] preflight failed: ${error.message} | command: ${invocation} | source: ${resolved.source} | ` +
          `fix: verify the OpenCLI install, or set OPENCLI_MCP_BIN (plus OPENCLI_MCP_PREFIX_ARGS) to a working executable\n`,
      );
    }
  })();
}

function describeVersion(result) {
  const raw = typeof result?.stdout === "string" ? result.stdout : "";
  const line = raw.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (line) return line;
  if (result?.data != null) return asJsonText(result.data);
  return "(no version output)";
}

function describeCandidatesSuffix(env, cwd) {
  try {
    const candidates = describeOpenCliCandidates(env, { cwd });
    if (Array.isArray(candidates) && candidates.length > 0) {
      const labels = candidates
        .map((candidate) => (typeof candidate === "string" ? candidate : candidate?.source ?? candidate?.command))
        .filter(Boolean);
      if (labels.length > 0) return ` | probed: ${labels.join(", ")}`;
    }
  } catch {
    // Candidate probing is best-effort diagnostics only.
  }
  return "";
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`preflight timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
