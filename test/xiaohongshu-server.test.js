import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { OpenCliError } from "../src/opencli-runner.js";

test("opencli_run advertises the effective media-cache limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-cache-description-"));
  const server = createServer({
    runOpenCli: async () => ({ data: "1.8.8" }),
    runnerOptions: {
      env: {
        OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root,
        OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES: "200",
        OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: "250",
      },
    },
  });
  const client = new Client({ name: "cache-description-test", version: "1.0" });
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
    assert.match(tools.get("opencli_status").description, /media-cache limits/);

    const status = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });
    assert.equal(status.structuredContent.media_cache.image_cache_max_files, 200);
    assert.equal(status.structuredContent.media_cache.download_cache_max_mb, 250);
    assert.equal(status.structuredContent.media_cache.directory_source, "environment");
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
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
