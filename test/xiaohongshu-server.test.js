import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { OpenCliError } from "../src/opencli-runner.js";

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
