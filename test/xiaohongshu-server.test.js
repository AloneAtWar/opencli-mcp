import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { OpenCliError } from "../src/opencli-runner.js";

test("opencli_status resolves the same project config as runner cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencli-status-cwd-"));
  const cwd = path.join(root, "nested");
  const entry = path.join(root, "cli.mjs");
  await mkdir(cwd);
  await writeFile(entry, 'console.log(JSON.stringify("cwd-fixture"));');
  await writeFile(path.join(root, ".opencli-mcp.json"), JSON.stringify({ bin: "./cli.mjs" }));
  const server = createServer({
    runnerOptions: {
      cwd,
      env: { ...process.env, OPENCLI_MCP_BIN: "", OPENCLI_MCP_PREFIX_ARGS: "" },
    },
  });
  const client = new Client({ name: "status-cwd-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const status = await client.callTool({ name: "opencli_status", arguments: {} });
    assert.notEqual(status.isError, true);
    assert.equal(status.structuredContent.value, "cwd-fixture");
    assert.deepEqual(status.structuredContent.resolution.prefixArgs, [entry]);
    assert.match(status.structuredContent.resolution.source, /\.opencli-mcp\.json/);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("opencli_status reports the effective media cache and the opt-in trace records tool names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-status-"));
  const trace = path.join(root, "calls.jsonl");
  const server = createServer({
    runOpenCli: async () => ({ data: "1.8.8" }),
    runnerOptions: {
      env: {
        OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root,
        OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES: "200",
        OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: "250",
        OPENCLI_MCP_TRACE_CALLS: trace,
      },
    },
  });
  const client = new Client({ name: "status-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const runDescription = tools.get("opencli_run").description;
    assert.match(runDescription, /OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB=250/);
    assert.match(runDescription, /250000000-byte soft budget/);
    assert.match(runDescription, /OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES=200/);
    assert.match(runDescription, /evicted FIFO by creation time/);
    assert.match(runDescription, /1 image block\(s\) per response for this MCP process/);
    assert.match(tools.get("opencli_status").description, /effective OpenCLI resolution, Xiaohongshu media-cache limits/);
    const status = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });
    assert.equal(status.structuredContent.media_cache.image_cache_max_files, 200);
    assert.equal(status.structuredContent.media_cache.download_cache_max_mb, 250);
    assert.equal(status.structuredContent.media_cache.directory_source, "environment");

    const secret = "TRACE_SECRET_123";
    await client.callTool({ name: "opencli_run", arguments: { site: "example", command: "search", args: [secret] } });

    const raw = await readFile(trace, "utf8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.tool === "opencli_status" && typeof line.ts === "string"));
    assert.ok(lines.some((line) => line.tool === "opencli_run" && line.arg_names.includes("args")));
    assert.equal(raw.includes(secret), false, "argument values never reach the trace");
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("opencli_adapter_list keeps the CLI-only array and still surfaces MCP-handled media subcommands", async () => {
  const run = async () => ({
    data: [{ site: "xiaohongshu", name: "download", command: "xiaohongshu/download", description: "下载小红书笔记中的图片和视频", domain: "www.xiaohongshu.com" }],
  });
  const server = createServer({ runOpenCli: run, runnerOptions: { env: {} } });
  const client = new Client({ name: "catalog-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const list = await client.callTool({ name: "opencli_adapter_list", arguments: { keywords: ["xiaohongshu"] } });
    assert.deepEqual(list.structuredContent.value.map((entry) => entry.command), ["xiaohongshu/download"]);
    const subcommands = list.structuredContent.mcp_handled_subcommands;
    const images = subcommands.find((entry) => entry.command === "images");
    assert.equal(images.tool, "opencli_run");
    assert.equal(images.site, "xiaohongshu");
    assert.equal(images.mcp_only, true);
    assert.equal(images.cli_command, null);
    const download = subcommands.find((entry) => entry.command === "download");
    assert.equal(download.handled_by_mcp, true);
    assert.equal(download.cli_command, "xiaohongshu/download");
    const textBlocks = list.content.filter((block) => block.type === "text");
    assert.equal(textBlocks.length, 2, "the CLI catalog and the MCP hint are separate text blocks");
    assert.match(textBlocks[1].text, /mcp_handled_subcommands/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a generic CLI failure reaches the agent through the shared failure summary", async () => {
  const run = async (args) => {
    if (args[0] === "broken") {
      throw new OpenCliError("element not found", {
        code: 3,
        stdout: "",
        stderr: "detail: selector missing\nsecond line",
        data: { error: { code: "BROWSER_ERROR", message: "element not found", hint: "retry with a ref" } },
      });
    }
    return { data: { ok: true } };
  };
  const server = createServer({ runOpenCli: run, runnerOptions: { env: {} } });
  const client = new Client({ name: "failure-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "opencli_run", arguments: { site: "broken", command: "read" } });
    assert.equal(result.isError, true);
    const error = result.structuredContent.error;
    assert.equal(error.code, "BROWSER_ERROR");
    assert.equal(error.message, "element not found");
    assert.equal(error.hint, "retry with a ref");
    assert.equal(error.cli_error_code, "BROWSER_ERROR");
    assert.equal(error.exit_code, 3);
    assert.equal(error.stderr_tail, "detail: selector missing | second line");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP exposes Xiaohongshu media only through opencli_run subcommands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-mcp-test-"));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "xiaohongshu" && args[1] === "download") {
      const output = args[args.indexOf("--output") + 1];
      await mkdir(path.join(output, "abc123"), { recursive: true });
      await writeFile(path.join(output, "abc123", "abc123_1.jpg"), Buffer.from("ffd8ffe000104a4649460001", "hex"));
      return { data: [{ index: 1, type: "image", status: "success", size: "12 B" }] };
    }
    return { data: { ok: true } };
  };
  const server = createServer({ runOpenCli: run, runnerOptions: { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root } } });
  const client = new Client({ name: "xhs-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("opencli_run"));
    assert.ok(!tools.some((name) => name.startsWith("xiaohongshu_")));
    const download = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "download", args: ["https://xhslink.com/test", "--output", root] } });
    assert.equal(download.isError, undefined);
    assert.equal(download.structuredContent.managed_cache, true);
    assert.equal(download.structuredContent.files.length, 1);
    assert.ok(path.isAbsolute(download.structuredContent.files[0].local_path));
    assert.equal(download.structuredContent.files[0].size_bytes, 12);
    const images = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "images", args: ["https://xhslink.com/test", "--indexes", "1"] } });
    assert.equal(images.content[0].type, "image");
    assert.equal(images.content[0].mimeType, "image/jpeg");
    assert.equal(Buffer.from(images.content[0].data, "base64").length, 12);
    assert.ok(!JSON.stringify(images.structuredContent).includes(root));
    const withOutput = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "images", args: ["https://xhslink.com/test", "--output", root] } });
    assert.equal(withOutput.isError, true);
    const duplicateIndex = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "images", args: ["https://xhslink.com/test", "--index", "2", "--index", "2"] } });
    assert.equal(duplicateIndex.isError, true);
    const unsupported = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "images", args: ["https://xhslink.com/test", "--nope"] } });
    assert.equal(unsupported.isError, true);
    const help = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "images", args: ["--help"] } });
    assert.match(help.structuredContent.help, /command="images"/);
    await client.callTool({ name: "opencli_run", arguments: { site: "instagram", command: "download", args: ["example", "--path", "unchanged"] } });
    assert.deepEqual(calls.at(-1), ["instagram", "download", "example", "--path", "unchanged", "-f", "json"]);
    const duplicate = await client.callTool({ name: "opencli_run", arguments: { site: "xiaohongshu", command: "download", args: ["https://xhslink.com/test", "--output", root, "--output", root] } });
    assert.equal(duplicate.isError, true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A lone surrogate anywhere in a tool result makes the peer reject the whole JSON
// body with HTTP 400 (invalid_json_payload), which tears the MCP session down.
// Upstream text can already be malformed - OpenCLI truncates page text by code
// unit too - so every result is normalized on the way out of `wrap`.
const LONE_SURROGATE = "\ud83d";

function findTextBlock(result) {
  return result.content.find((block) => block.type === "text").text;
}

test("tool results are made well-formed before they leave the server", async () => {
  const server = createServer({
    runOpenCli: async () => ({ data: `release 1.8.8${LONE_SURROGATE}` }),
    runnerOptions: { env: {} },
  });
  const client = new Client({ name: "well-formed-result", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });

    const text = findTextBlock(result);
    assert.equal(text.isWellFormed(), true);
    assert.equal(result.structuredContent.value.isWellFormed(), true);
    assert.equal(result.structuredContent.value, "release 1.8.8\uFFFD");
    assert.equal(text.includes("\\ud83d"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("error results are made well-formed too", async () => {
  const server = createServer({
    runOpenCli: async () => {
      throw new Error(`OpenCLI exploded ${LONE_SURROGATE}`);
    },
    runnerOptions: { env: {} },
  });
  const client = new Client({ name: "well-formed-error", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });

    assert.equal(result.isError, true);
    const text = findTextBlock(result);
    assert.equal(text.isWellFormed(), true);
    assert.equal(result.structuredContent.error.message.isWellFormed(), true);
  } finally {
    await client.close();
    await server.close();
  }
});

// A compact page snapshot is one result shape that can carry a lone surrogate in
// two ways: the wrapper's own cut landing inside a pair, and text that arrived
// from OpenCLI already broken.
test("compact snapshots reach the host well-formed either way", async () => {
  const emojiLine = `${"内容👍看板\n".repeat(400)}`;
  const cases = [
    // Already broken upstream, and small enough that nothing gets truncated: only
    // the boundary sanitizer can save this one.
    { label: "dirty upstream", data: `URL: https://example.com\n👍${LONE_SURROGATE}`, maxChars: 12_000, repaired: true },
    // Invariant guard on the wrapper's own compaction: whatever the budget, the
    // host never receives a lone surrogate or a replacement character. (The
    // compaction budget reserves room for its marker, so this path does not cut
    // in practice - the reachable cuts are covered by browser-flow's preview
    // test and browser-advanced's in-page tests.)
    ...Array.from({ length: 13 }, (_, index) => ({
      label: `budget sweep ${2000 + index}`,
      data: `URL: https://example.com\n${emojiLine}`,
      maxChars: 2000 + index,
      repaired: false,
    })),
  ];

  for (const { label, data, maxChars, repaired } of cases) {
    const server = createServer({ runOpenCli: async () => ({ data }), runnerOptions: { env: {} } });
    const client = new Client({ name: `snapshot-${label}`, version: "1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "browser_snapshot_compact",
        arguments: { max_chars: maxChars, max_lines: 500 },
      });

      assert.ok(!result.isError, `${label} call`);
      const text = findTextBlock(result);
      assert.equal(text.isWellFormed(), true, label);
      assert.equal(result.structuredContent.value.isWellFormed(), true, label);
      assert.equal(text.includes("\\ud83d"), false, label);
      assert.ok(result.structuredContent.value.length <= maxChars, `${label} budget`);

      if (repaired) {
        assert.equal(result.structuredContent.value.includes("\uFFFD"), true, `${label} repaired in place`);
      } else {
        // A clean cut drops the half character instead of corrupting it.
        assert.equal(result.structuredContent.value.includes("\uFFFD"), false, label);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});
