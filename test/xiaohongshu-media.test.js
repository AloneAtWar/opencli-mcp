// Module-level tests for src/xiaohongshu-media.js.
//
// The MCP surface (tool wiring, in-memory server round trip) is covered by
// test/xiaohongshu-server.test.js; this file exercises the media module itself:
// download-root resolution, the on-disk request-dir layout, file inventory,
// native ImageContent construction, and the shared size / image-count cleanup.
//
// The fake OpenCLI runner writes real files into the directory it receives via
// `--output`, so every assertion is made against bytes that actually exist on
// disk rather than mocked metadata.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, utimes, rm, readdir, lstat } from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { OpenCliError } from "../src/opencli-runner.js";
import * as xiaohongshuMedia from "../src/xiaohongshu-media.js";

const { createXiaohongshuMedia } = xiaohongshuMedia;
const resolveDownloadRoot = xiaohongshuMedia.resolveDownloadRoot;

// Minimal real magic-byte headers: JPEG SOI + JFIF APP0, PNG signature + IHDR,
// and an ISO base media `ftyp` box (video).
const JPEG = Buffer.from("ffd8ffe000104a4649460001", "hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MP4 = Buffer.from("000000186674797069736f6d", "hex");

const IMAGE_CACHE_DIR = "opencli-xhs-images";
const MIB = 1024 * 1024;

function bytesWithMagic(magic, size) {
  return Buffer.concat([magic, Buffer.alloc(Math.max(0, size - magic.length), 0x20)]);
}

function tempRoot(label = "xhs-media") {
  return mkdtemp(path.join(os.tmpdir(), `${label}-`));
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  }
  await walk(dir);
  return found;
}

// Symlink creation needs elevation on Windows, so the one symlink assertion is
// allowed to be skipped; everything else in this file must run for real.
async function symlinkSupported(dir) {
  const target = path.join(dir, "symlink-probe-target");
  const link = path.join(dir, "symlink-probe-link");
  try {
    await writeFile(target, "probe");
    await symlink(target, link);
    return true;
  } catch {
    return false;
  } finally {
    await rm(link, { force: true });
    await rm(target, { force: true });
  }
}

function rootOf(result) {
  if (typeof result === "string") return result;
  return result?.root ?? result?.download_root ?? result?.path ?? result?.directory;
}

function sourceOf(result) {
  if (typeof result === "string") return "";
  return String(result?.source ?? result?.directory_source ?? "");
}

/** Compare resolved paths the way the host filesystem would, case-insensitively on Windows. */
function samePath(left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Normalize separators so POSIX-style expectations also hold on a Windows host. */
function posixish(value) {
  return String(value).replaceAll("\\", "/");
}

function outputDirOf(args) {
  const index = args.indexOf("--output");
  assert.ok(index >= 0 && index < args.length - 1, `CLI call must pass --output <dir>: ${JSON.stringify(args)}`);
  return args[index + 1];
}

/**
 * Fake OpenCLI runner. Each entry in `plans` describes one CLI invocation: the
 * files (and symlinks) it writes into the `--output` request directory, plus an
 * optional `onCall` hook, an optional `block` gate, and an optional failure
 * (`true` for a normal non-zero exit, `"timeout"` for a killed process) that is
 * raised after those files land. `cliResult` replaces the whole CLI payload.
 */
function cliRowsFor(files = []) {
  return files.map((file, index) => ({
    index: index + 1,
    type: /\.(mp4|mov|m4v)$/i.test(file.name) ? "video" : "image",
    status: "success",
    size: `${file.bytes?.length ?? file.size ?? 0} B`,
  }));
}

function runnerFor(plans, calls = []) {
  const queue = [...plans];
  return async (args, options = {}) => {
    calls.push({ args, options });
    const plan = queue.shift();
    assert.ok(plan, `unexpected extra CLI call: ${JSON.stringify(args)}`);
    const noteDir = path.join(outputDirOf(args), plan.noteId ?? "note1");
    await mkdir(noteDir, { recursive: true });
    for (const file of plan.files ?? []) {
      const target = path.join(noteDir, file.name);
      await writeFile(target, file.bytes ?? Buffer.alloc(file.size ?? 0, 0x20));
      if (file.mtime !== undefined) await utimes(target, file.mtime, file.mtime);
    }
    for (const link of plan.links ?? []) {
      await symlink(link.target, path.join(noteDir, link.name));
    }
    if (plan.onCall) await plan.onCall(args);
    if (plan.block) await plan.block;
    if (plan.throws) throw plan.throws;
    if (plan.fail === "timeout") {
      throw new OpenCliError("OpenCLI timed out after 90000ms", { code: "TIMEOUT", command: "opencli", args });
    }
    if (plan.fail === "timeout_confirmed") {
      throw new OpenCliError("OpenCLI timed out after 90000ms", {
        code: "TIMEOUT",
        command: "opencli",
        args,
        termination_confirmed: true,
      });
    }
    if (plan.fail) {
      throw new OpenCliError("OpenCLI exited with code 1", {
        code: 1,
        stdout: "",
        stderr: "note unavailable",
        data: { error: { code: "XHS_NOTE_ERROR", message: "note unavailable" } },
      });
    }
    if (plan.cliResult) return typeof plan.cliResult === "function" ? plan.cliResult(args) : plan.cliResult;
    return {
      ok: true,
      code: 0,
      stdout: "",
      stderr: "",
      data: plan.cliData ?? cliRowsFor(plan.files),
    };
  };
}

function makeMedia(plans, { env = {}, cwd, calls = [] } = {}) {
  // The images entry point takes no explicit output, so pin the download root to
  // the test's own directory. Without this a test would resolve the OS default
  // and write into the real user Downloads folder.
  const mergedEnv = cwd === undefined ? { ...env } : { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: cwd, ...env };
  return { media: createXiaohongshuMedia({ run: runnerFor(plans, calls), env: mergedEnv, cwd }), calls };
}

function navigationRejected() {
  return new OpenCliError("Navigation rejected.", { code: 1, stdout: "", stderr: "Navigation rejected." });
}

function timeoutMentioningNavigation() {
  return new OpenCliError("OpenCLI timed out after 90000ms", { code: "TIMEOUT", stdout: "", stderr: "Navigation rejected." });
}

function imageBlocks(result) {
  return result.content.filter((block) => block.type === "image");
}

function cacheWorker(t) {
  const child = fork(new URL('./fixtures/media-cache-worker.js', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [], pending = [];
  let stderr = '', exited = false;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    const index = pending.findIndex(waiter => waiter.type === message.type);
    if (index < 0) messages.push(message);
    else pending.splice(index, 1)[0].resolve(message);
  });
  child.on('error', error => { for (const waiter of pending.splice(0)) waiter.reject(error); });
  child.on('exit', (code, signal) => {
    exited = true;
    for (const waiter of pending.splice(0)) waiter.reject(new Error(`media cache worker exited (${code ?? signal}): ${stderr}`));
  });
  const stop = async () => {
    if (!exited) { const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed; }
  };
  t.after(stop);
  return {
    child,
    stop,
    send: message => child.send(message),
    wait(type) {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (exited) return Promise.reject(new Error(`media cache worker already exited: ${stderr}`));
      return new Promise((resolve, reject) => pending.push({ type, resolve, reject }));
    },
  };
}

test("download() writes one request dir per call and reports verified absolute files", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        {
          noteId: "abc123",
          files: [
            { name: "abc123_1.jpg", bytes: JPEG },
            { name: "abc123_1.mp4", bytes: MP4 },
          ],
        },
      ],
      { env: {}, cwd: root },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", output: root });

    assert.equal(result.isError, undefined);
    const sc = result.structuredContent;
    assert.equal(sc.status, "success");
    assert.equal(sc.path_scope, "server_local");
    assert.equal(sc.managed_cache, true);
    assert.equal(sc.inventory_complete, true);
    assert.equal(sc.download_root, path.resolve(root));
    assert.equal(path.dirname(sc.output_directory), path.resolve(root));
    assert.match(path.basename(sc.output_directory), /^opencli-xhs-/);
    assert.ok(typeof sc.directory_source === "string" && sc.directory_source.length > 0);
    assert.ok(sc.cli_result, "the CLI result is reported next to the file list");

    assert.equal(sc.files.length, 2);
    const jpeg = sc.files.find((file) => file.local_path.endsWith("abc123_1.jpg"));
    assert.ok(path.isAbsolute(jpeg.local_path));
    assert.equal(jpeg.size_bytes, JPEG.length);
    assert.equal(jpeg.mime_type, "image/jpeg");
    assert.ok(jpeg.local_path.startsWith(path.join(sc.output_directory, "abc123")));

    const video = sc.files.find((file) => file.local_path.endsWith(".mp4"));
    assert.equal(video.size_bytes, MP4.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("download_root prefers an explicit output over OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR", async () => {
  const envRoot = await tempRoot("xhs-env");
  const explicitRoot = await tempRoot("xhs-explicit");
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }] },
        { noteId: "n2", files: [{ name: "n2_1.jpg", bytes: JPEG }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: envRoot }, cwd: envRoot, calls },
    );

    const explicit = await media.download({ note_url: "https://xhslink.com/a", output: explicitRoot });
    assert.equal(explicit.structuredContent.download_root, path.resolve(explicitRoot));
    assert.ok(explicit.structuredContent.output_directory.startsWith(path.resolve(explicitRoot) + path.sep));

    const fromEnv = await media.download({ note_url: "https://xhslink.com/b" });
    assert.equal(fromEnv.structuredContent.download_root, path.resolve(envRoot));
    assert.ok(fromEnv.structuredContent.output_directory.startsWith(path.resolve(envRoot) + path.sep));
    assert.equal(
      outputDirOf(calls.at(-1).args),
      fromEnv.structuredContent.output_directory,
      "the CLI --output is the request dir that is reported back",
    );
  } finally {
    await rm(envRoot, { recursive: true, force: true });
    await rm(explicitRoot, { recursive: true, force: true });
  }
});

// --- download-root resolver -------------------------------------------------
// Exercised directly as a pure function with injected platform dependencies, so
// the OS-default branches are covered without ever writing to the real user
// Downloads directory.

test("the module exports resolveDownloadRoot for direct resolver testing", () => {
  assert.equal(
    typeof resolveDownloadRoot,
    "function",
    "src/xiaohongshu-media.js must export resolveDownloadRoot(env, deps) so download_root resolution is testable",
  );
});

test("resolver prefers explicit output > OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR > OS downloads", () => {
  const base = path.join(os.tmpdir(), "xhs-resolver");
  const explicit = path.join(base, "explicit");
  const envRoot = path.join(base, "env");
  const osDownloads = path.join(base, "Downloads");
  const deps = { platform: "win32", homeDir: base, osDownloadsDir: osDownloads, cwd: base };

  assert.ok(
    samePath(rootOf(resolveDownloadRoot({ OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: envRoot }, { ...deps, output: explicit })), explicit),
    "an explicit output wins over the env dir",
  );
  assert.ok(
    samePath(rootOf(resolveDownloadRoot({ OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: envRoot }, deps)), envRoot),
    "the env dir wins over the OS default",
  );
  assert.ok(
    samePath(rootOf(resolveDownloadRoot({}, deps)), osDownloads),
    "the OS downloads dir is the last resort",
  );
  assert.ok(
    samePath(rootOf(resolveDownloadRoot({ OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: "   " }, deps)), osDownloads),
    "a whitespace-only env value counts as unset",
  );
});

test("resolver rejects a Windows drive-relative output path", () => {
  const base = path.join(os.tmpdir(), "xhs-resolver");
  assert.throws(
    () => resolveDownloadRoot({}, { platform: "win32", homeDir: base, cwd: base, output: "E:foo" }),
    /drive|E:foo|absolute/i,
  );
});

test("resolver expands $HOME in the Linux XDG downloads mapping", () => {
  const readFileSync = (file) => {
    if (posixish(file).endsWith("user-dirs.dirs")) return 'XDG_DOWNLOAD_DIR="$HOME/Downloads"\n';
    throw new Error(`unexpected read: ${file}`);
  };

  const result = resolveDownloadRoot(
    {},
    {
      platform: "linux",
      homeDir: "/home/u",
      cwd: "/home/u",
      existsSync: (target) => posixish(target).endsWith("user-dirs.dirs"),
      readFileSync,
    },
  );

  assert.match(posixish(rootOf(result)), /\/home\/u\/Downloads$/);
});

test("resolver falls back to the user Downloads dir and marks the fallback", () => {
  const base = path.join(os.tmpdir(), "xhs-resolver");

  const windowsFallback = resolveDownloadRoot({}, { platform: "win32", homeDir: base, cwd: base, osDownloadsDir: null });
  assert.ok(samePath(rootOf(windowsFallback), path.join(base, "Downloads")));
  assert.match(sourceOf(windowsFallback), /fallback/i, "the OS query fallback is labelled");

  const macFallback = resolveDownloadRoot({}, { platform: "darwin", homeDir: "/Users/u", cwd: "/Users/u", osDownloadsDir: null });
  assert.match(posixish(rootOf(macFallback)), /\/Users\/u\/Downloads$/);
});

test("a failing CLI still returns the files that were actually verified", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [{ noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }], fail: true }],
      { env: {}, cwd: root },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", output: root });

    assert.equal(result.isError, undefined, "a partial download is a result, not a hard tool error");
    const sc = result.structuredContent;
    assert.notEqual(sc.status, "success");
    assert.equal(sc.files.length, 1);
    assert.ok(sc.files[0].local_path.endsWith("n1_1.jpg"));
    assert.ok(sc.cli_result, "the CLI outcome is reported beside the verified files");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("images() returns native image blocks with byte-derived MIME for the selected index", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        {
          noteId: "abc",
          files: [
            { name: "abc_1.jpg", bytes: JPEG },
            { name: "abc_2.jpg", bytes: PNG },
          ],
        },
      ],
      { env: {}, cwd: root },
    );

    const result = await media.images({ note_url: "https://xhslink.com/a", image_indexes: [2] });

    const blocks = imageBlocks(result);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(blocks[0].data, "base64"), PNG);

    const sc = result.structuredContent;
    assert.equal(sc.status, "success");
    assert.equal(sc.images.length, 1);
    assert.equal(sc.images[0].index, 2);
    assert.equal(sc.images[0].mime_type, "image/png");
    assert.equal(sc.images[0].size_bytes, PNG.length);
    assert.deepEqual(sc.errors, []);
    assert.doesNotMatch(JSON.stringify(sc), /local_path|output_directory|download_root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("images() never returns video media as image content", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        {
          noteId: "abc",
          files: [
            { name: "abc_1.jpg", bytes: JPEG },
            { name: "abc_2.mp4", bytes: MP4 },
          ],
        },
      ],
      { env: {}, cwd: root },
    );

    const result = await media.images({ note_url: "https://xhslink.com/a" });

    const blocks = imageBlocks(result);
    assert.equal(blocks.length, 1);
    assert.ok(blocks.every((block) => block.mimeType.startsWith("image/")));
    assert.equal(blocks[0].mimeType, "image/jpeg");
    assert.equal(result.structuredContent.images.length, 1);
    assert.equal(result.structuredContent.images[0].mime_type, "image/jpeg");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("images() skips media above the per-file byte budget", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        {
          noteId: "abc",
          files: [
            { name: "abc_1.jpg", bytes: bytesWithMagic(JPEG, 10 * MIB + 1) },
            { name: "abc_2.jpg", bytes: JPEG },
          ],
        },
      ],
      { env: {}, cwd: root },
    );

    const result = await media.images({ note_url: "https://xhslink.com/a" });

    const blocks = imageBlocks(result);
    assert.equal(blocks.length, 1);
    assert.equal(Buffer.from(blocks[0].data, "base64").length, JPEG.length);
    assert.ok(result.structuredContent.errors.length >= 1, "the oversized file is reported");
    assert.equal(result.structuredContent.images.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("images() keeps the total payload within the 20 MiB budget", async () => {
  const root = await tempRoot();
  try {
    const chunk = 7 * MIB;
    const { media } = makeMedia(
      [
        {
          noteId: "abc",
          files: [
            { name: "abc_1.jpg", bytes: bytesWithMagic(JPEG, chunk) },
            { name: "abc_2.jpg", bytes: bytesWithMagic(JPEG, chunk) },
            { name: "abc_3.jpg", bytes: bytesWithMagic(JPEG, chunk) },
          ],
        },
      ],
      { env: { OPENCLI_XIAOHONGSHU_IMAGE_BLOCKS_PER_RESPONSE: "20" }, cwd: root },
    );

    const result = await media.images({ note_url: "https://xhslink.com/a" });

    const blocks = imageBlocks(result);
    const total = blocks.reduce((sum, block) => sum + Buffer.from(block.data, "base64").length, 0);
    assert.ok(total <= 20 * MIB, `total payload ${total} exceeded the 20 MiB budget`);
    assert.equal(blocks.length, 2);
    assert.ok(result.structuredContent.errors.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("images() returns one image block by default and pages the rest through skipped_indexes", async () => {
  const root = await tempRoot();
  try {
    const files = Array.from({ length: 21 }, (_, offset) => ({ name: `abc_${offset + 1}.jpg`, bytes: JPEG }));
    const { media } = makeMedia([{ noteId: "abc", files }], { env: {}, cwd: root });

    const result = await media.images({ note_url: "https://xhslink.com/a" });

    assert.equal(imageBlocks(result).length, 1, "the default per-response image-block budget is one");
    assert.equal(result.structuredContent.image_blocks_per_response, 1);
    assert.equal(result.structuredContent.status, "success");
    assert.deepEqual(result.structuredContent.available_indexes, Array.from({ length: 21 }, (_, offset) => offset + 1));
    assert.deepEqual(result.structuredContent.skipped_indexes, Array.from({ length: 20 }, (_, offset) => offset + 2));
    assert.equal(result.structuredContent.errors.length, 0);
    assert.equal(result.structuredContent.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("images() pages everything past a raised budget of 20", async () => {
  const root = await tempRoot();
  try {
    const files = Array.from({ length: 21 }, (_, offset) => ({ name: `abc_${offset + 1}.jpg`, bytes: JPEG }));
    const { media } = makeMedia([{ noteId: "abc", files }], { env: { OPENCLI_XIAOHONGSHU_IMAGE_BLOCKS_PER_RESPONSE: "20" }, cwd: root });

    const result = await media.images({ note_url: "https://xhslink.com/a" });

    assert.equal(imageBlocks(result).length, 20);
    assert.deepEqual(result.structuredContent.skipped_indexes, [21], "everything past the hard cap is paged, not an error");
    assert.equal(result.structuredContent.status, "success");
    assert.equal(result.structuredContent.errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("images() pages explicitly requested indexes too", async () => {
  const root = await tempRoot();
  try {
    const files = Array.from({ length: 3 }, (_, offset) => ({ name: `abc_${offset + 1}.jpg`, bytes: JPEG }));
    const { media } = makeMedia([{ noteId: "abc", files }], { env: {}, cwd: root });

    const result = await media.images({ note_url: "https://xhslink.com/a", image_indexes: [2, 3] });

    assert.equal(imageBlocks(result).length, 1);
    assert.deepEqual(result.structuredContent.images.map((image) => image.index), [2]);
    assert.deepEqual(result.structuredContent.skipped_indexes, [3]);
    assert.equal(result.structuredContent.status, "success");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent downloads for the same note stay in separate request dirs", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        { noteId: "same", files: [{ name: "same_1.jpg", bytes: JPEG }] },
        { noteId: "same", files: [{ name: "same_1.jpg", bytes: PNG }] },
      ],
      { env: {}, cwd: root },
    );

    const [first, second] = await Promise.all([
      media.download({ note_url: "https://xhslink.com/a", output: root }),
      media.download({ note_url: "https://xhslink.com/a", output: root }),
    ]);

    const dirs = [first.structuredContent.output_directory, second.structuredContent.output_directory];
    assert.notEqual(dirs[0], dirs[1]);

    const sizes = [];
    for (const dir of dirs) {
      const files = await listFiles(dir);
      assert.equal(files.length, 1, `each request dir holds only its own file: ${JSON.stringify(files)}`);
      sizes.push((await lstat(files[0])).size);
    }
    assert.deepEqual(sizes.slice().sort((a, b) => a - b), [JPEG.length, PNG.length].sort((a, b) => a - b));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent processes preserve every ownership record and reclaim the shared cache', { timeout: 30_000 }, async (t) => {
  const root = await tempRoot('xhs-shared-cache');
  const workers = [];
  try {
    await writeFile(path.join(root, 'keep.txt'), 'user data');
    for (let i = 0; i < 6; i++) workers.push(cacheWorker(t));
    await Promise.all(workers.map(worker => worker.wait('ready')));
    for (const worker of workers) worker.send({ root, pauseDownload: true });
    const started = await Promise.all(workers.map(worker => worker.wait('started')));
    const inFlight = JSON.parse(await readFile(path.join(root, '.opencli-xhs-owned.json'), 'utf8'));
    assert.equal(inFlight.tasks.length, workers.length, 'registration merges records from every process');
    assert.ok(inFlight.tasks.every(task => task.quarantined), 'other processes protect every live writer');

    for (const worker of workers) worker.send({ release: true });
    const results = await Promise.all(workers.map(worker => worker.wait('result')));
    for (const response of results) {
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      assert.equal(response.data.status, 'success');
      assert.deepEqual(response.data.errors, []);
    }
    const completed = JSON.parse(await readFile(path.join(root, '.opencli-xhs-owned.json'), 'utf8'));
    assert.equal(completed.tasks.length, workers.length);
    assert.ok(completed.tasks.every(task => task.quarantined === false));
    for (const { directory } of started) assert.ok(await exists(directory));

    const cleaner = cacheWorker(t);
    workers.push(cleaner);
    await cleaner.wait('ready');
    cleaner.send({ root, maxMb: 1 });
    const cleaned = await cleaner.wait('result');
    assert.equal(cleaned.error, undefined, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.status, 'success');
    for (const { directory } of started) assert.equal(await exists(directory), false, 'old tasks from every process are reclaimed');
    const retained = JSON.parse(await readFile(path.join(root, '.opencli-xhs-owned.json'), 'utf8'));
    assert.deepEqual(retained.tasks.map(task => task.name), [path.basename(cleaned.data.output_directory)]);
    assert.ok(await exists(cleaned.data.files[0].local_path));
    assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'user data');
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await rm(root, { recursive: true, force: true });
  }
});

test('another process cannot reclaim an image while its inventory is being read', { timeout: 15_000 }, async (t) => {
  const root = await tempRoot('xhs-shared-reader');
  const reader = cacheWorker(t), cleaner = cacheWorker(t);
  try {
    await Promise.all([reader.wait('ready'), cleaner.wait('ready')]);
    reader.send({ root, operation: 'images', pauseInventory: true });
    const { directory } = await reader.wait('started');
    await reader.wait('reading');
    cleaner.send({ root, maxMb: 1 });
    const cleaned = await cleaner.wait('result');
    assert.equal(cleaned.error, undefined, JSON.stringify(cleaned.error));
    assert.ok(await exists(path.join(directory, 'note', 'note_1.jpg')), 'shared cleanup protects another process reading images');
    const owned = JSON.parse(await readFile(path.join(root, '.opencli-xhs-owned.json'), 'utf8'));
    assert.equal(owned.tasks.find(task => task.name === path.basename(directory)).quarantined, true);
    reader.send({ release: true });
    const images = await reader.wait('result');
    assert.equal(images.error, undefined, JSON.stringify(images.error));
    assert.equal(images.data.status, 'success');
    assert.equal(images.data.images.length, 1);
  } finally {
    await Promise.all([reader.stop(), cleaner.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('an expired lock left by a killed process is recovered without losing media records', { timeout: 15_000 }, async (t) => {
  const root = await tempRoot('xhs-crashed-lock');
  const holder = cacheWorker(t), next = cacheWorker(t);
  try {
    const { media } = makeMedia([{ noteId: 'before', files: [{ name: 'before_1.jpg', bytes: JPEG }] }], { cwd: root });
    const previous = await media.download({ note_url: 'https://xhslink.com/a' });
    await Promise.all([holder.wait('ready'), next.wait('ready')]);
    holder.send({ root, operation: 'hold_lock' });
    await holder.wait('held');
    await holder.stop(); // SIGKILL bypasses proper-lockfile's graceful-exit cleanup.
    const lockPath = path.join(root, '.opencli-xhs-owned.json.lock');
    assert.ok(await exists(lockPath));
    // Simulate the stale interval passing after the real holder has crashed.
    await utimes(lockPath, new Date(0), new Date(0));
    next.send({ root });
    const response = await next.wait('result');
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.data.status, 'success');
    const owned = JSON.parse(await readFile(path.join(root, '.opencli-xhs-owned.json'), 'utf8'));
    assert.equal(owned.tasks.length, 2);
    assert.ok(await exists(previous.structuredContent.files[0].local_path));
    assert.equal(await exists(lockPath), false, 'the recovered lock is released normally');
  } finally {
    await Promise.all([holder.stop(), next.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed inventory releases temporary cross-process read protection', { timeout: 15_000 }, async (t) => {
  const root = await tempRoot('xhs-failed-reader');
  const worker = cacheWorker(t);
  try {
    await worker.wait('ready');
    worker.send({ root, operation: 'images', failInventory: true });
    const response = await worker.wait('result');
    assert.equal(response.error.code, 'EACCES');
    const owned = JSON.parse(await readFile(path.join(root, '.opencli-xhs-owned.json'), 'utf8'));
    assert.equal(owned.tasks.length, 1);
    assert.equal(owned.tasks[0].quarantined, false, 'a settled writer is not permanently quarantined because reading failed');
  } finally {
    await worker.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a compromised cache lock fails the transaction without exiting the MCP process', { timeout: 15_000 }, async (t) => {
  const root = await tempRoot('xhs-compromised-lock');
  const worker = cacheWorker(t);
  try {
    const original = { version: 1, tasks: [] };
    await writeFile(path.join(root, '.opencli-xhs-owned.json'), JSON.stringify(original));
    await worker.wait('ready');
    worker.send({ root, pauseManifest: true });
    await worker.wait('paused');
    await rm(path.join(root, '.opencli-xhs-owned.json.lock'), { recursive: true });
    const compromised = await worker.wait('compromised');
    assert.equal(compromised.code, 'ECOMPROMISED');
    worker.send({ release: true });
    const response = await worker.wait('result');
    assert.equal(response.error.code, 'ECOMPROMISED', 'the caller receives the lock failure as an ordinary rejected transaction');
    assert.deepEqual(JSON.parse(await readFile(path.join(root, '.opencli-xhs-owned.json'), 'utf8')), original, 'a transaction that lost its lock cannot publish a replacement manifest');
  } finally {
    await worker.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("size quota reclaims the oldest managed taskdir across both entry points", async () => {
  const root = await tempRoot();
  try {
    await writeFile(path.join(root, "keep.txt"), "user data");
    await mkdir(path.join(root, "user-stuff"), { recursive: true });
    await writeFile(path.join(root, "user-stuff", "keep2.txt"), "user data");

    const symlinkOk = await symlinkSupported(root);
    const calls = [];
    const { media } = makeMedia(
      [
        {
          noteId: "d1",
          files: [{ name: "d1_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }],
          links: symlinkOk ? [{ name: "escape.txt", target: path.join(root, "keep.txt") }] : [],
        },
        { noteId: "i1", files: [{ name: "i1_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }] },
      ],
      {
        env: {
          OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root,
          OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: "1",
        },
        cwd: root,
        calls,
      },
    );

    const download = await media.download({ note_url: "https://xhslink.com/a" });
    const downloadDir = download.structuredContent.output_directory;
    assert.equal(download.structuredContent.files.length, 1, "symlinks are excluded from the inventory");
    assert.ok(download.structuredContent.files[0].local_path.endsWith("d1_1.jpg"));
    assert.ok(await exists(downloadDir));

    await media.images({ note_url: "https://xhslink.com/b" });
    const imagesDir = outputDirOf(calls.at(-1).args);

    assert.ok(!(await exists(downloadDir)), "the oldest taskdir is reclaimed once the budget is exceeded");
    assert.ok(await exists(imagesDir), "the request dir returned by this call is retained");
    assert.equal(path.basename(path.dirname(imagesDir)), IMAGE_CACHE_DIR);
    assert.ok(await exists(path.join(root, IMAGE_CACHE_DIR)), "the images container itself is preserved");
    assert.ok(await exists(path.join(root, "keep.txt")), "user files in the root are never reclaimed");
    assert.ok(await exists(path.join(root, "user-stuff", "keep2.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image-count cleanup keeps the newest files and preserves the container", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        {
          noteId: "n1",
          files: [
            { name: "n1_1.jpg", bytes: JPEG, mtime: 1_000 },
            { name: "n1_2.jpg", bytes: PNG, mtime: 2_000 },
            { name: "n1_3.jpg", bytes: JPEG, mtime: 3_000 },
          ],
        },
      ],
      {
        env: {
          OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root,
          OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES: "1",
        },
        cwd: root,
      },
    );

    await media.images({ note_url: "https://xhslink.com/a" });

    const cacheFiles = await listFiles(path.join(root, IMAGE_CACHE_DIR));
    assert.equal(cacheFiles.length, 1);
    assert.ok(cacheFiles[0].endsWith("n1_3.jpg"), `expected the newest file to survive, got ${cacheFiles[0]}`);
    assert.ok(await exists(path.join(root, IMAGE_CACHE_DIR)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an explicit empty output and duplicate --output arguments", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [{ noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }] }],
      { env: {}, cwd: root },
    );

    const empty = await media
      .download({ note_url: "https://xhslink.com/a", output: "" })
      .then((value) => value, (error) => ({ isError: true, error }));
    assert.equal(empty.isError, true, "an explicit empty output path is rejected");

    const duplicate = await media
      .runDownload(["https://xhslink.com/a", "--output", root, "--output", root], { format: "json" })
      .then((value) => value, (error) => ({ isError: true, error }));
    assert.equal(duplicate.isError, true, "duplicate --output arguments are rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDownload() routes Xiaohongshu download through the managed cache", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [{ noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }] }],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.runDownload(["https://xhslink.com/a"], { format: "json" });

    assert.equal(result.structuredContent.managed_cache, true);
    assert.equal(result.structuredContent.files.length, 1);
    assert.ok(path.isAbsolute(result.structuredContent.files[0].local_path));

    const args = calls.at(-1).args;
    assert.equal(args[0], "xiaohongshu");
    assert.equal(args[1], "download");
    assert.ok(outputDirOf(args).startsWith(path.resolve(root) + path.sep));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Navigation rejected download is replayed once on a separate browser session", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "n1", files: [{ name: "n1_stale.jpg", bytes: JPEG }], throws: navigationRejected() },
        { noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", timeout_ms: 1000 });

    assert.equal(result.structuredContent.status, "success");
    assert.deepEqual(result.structuredContent.retry, {
      reason: "navigation_rejected",
      attempts: 2,
      session: "persistent",
      outcome: "success",
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.env, undefined, "the first attempt keeps the process environment");
    assert.deepEqual(calls[1].options.env, { OPENCLI_SITE_SESSION: "persistent" });
    assert.deepEqual(
      result.structuredContent.files.map((file) => path.basename(file.local_path)),
      ["n1_1.jpg"],
      "the replay starts from a clean request directory, so the first attempt cannot leak files",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicitly persistent run is retried on an ephemeral session", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "n1", files: [], throws: navigationRejected() },
        { noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root, OPENCLI_SITE_SESSION: "persistent" }, cwd: root, calls },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", timeout_ms: 1000 });

    assert.equal(result.structuredContent.retry.session, "ephemeral");
    assert.deepEqual(calls[1].options.env, { OPENCLI_SITE_SESSION: "ephemeral" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeated Navigation rejected failure is reported with a retry record and a hint", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "n1", files: [], throws: navigationRejected() },
        { noteId: "n1", files: [], throws: navigationRejected() },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", timeout_ms: 1000 });

    assert.equal(result.structuredContent.status, "error");
    assert.equal(result.structuredContent.error.code, "CLI_ERROR");
    assert.equal(result.structuredContent.error.message, "Navigation rejected.");
    assert.match(result.structuredContent.error.hint, /tab navigation/i);
    assert.equal(result.structuredContent.retry.outcome, "failed");
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replay that still reports per-media failures is not recorded as a success", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "n1", files: [], throws: navigationRejected() },
        {
          noteId: "n1",
          files: [{ name: "n1_1.jpg", bytes: JPEG }],
          cliData: [
            { index: 1, type: "image", status: "success", size: `${JPEG.length} B` },
            { index: 2, type: "image", status: "error", size: "HTTP 403 Forbidden" },
          ],
        },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", timeout_ms: 1000 });

    assert.equal(result.structuredContent.status, "partial");
    assert.equal(result.structuredContent.retry.outcome, "partial", "outcome follows the media verdict, not the exit code");
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replay that itself times out is recorded as failed and stays unconfirmed", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "n1", files: [], throws: navigationRejected() },
        { noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }], throws: timeoutMentioningNavigation() },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", timeout_ms: 1000 });

    assert.equal(result.structuredContent.retry.outcome, "failed");
    assert.equal(result.structuredContent.inventory_complete, false);
    assert.deepEqual(result.structuredContent.files, [], "an unconfirmed replay is never inventoried");
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unrelated CLI failure is not replayed", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [{ noteId: "n1", files: [], fail: true }],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", timeout_ms: 1000 });

    assert.equal(result.structuredContent.status, "error");
    assert.equal(result.structuredContent.retry, undefined);
    assert.equal(calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timed-out run is never replayed even when its stderr mentions a rejected navigation", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [{ noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }], throws: timeoutMentioningNavigation() }],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.download({ note_url: "https://xhslink.com/a", timeout_ms: 1000 });

    assert.equal(calls.length, 1, "a run we stopped must never be replayed");
    assert.equal(result.structuredContent.retry, undefined);
    assert.equal(result.structuredContent.inventory_complete, false);
    assert.equal(result.structuredContent.status, "error");
    assert.deepEqual(result.structuredContent.files, [], "an unconfirmed writer keeps its directory out of the inventory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("size cleanup never reclaims a request dir that is still in flight", async () => {
  const root = await tempRoot();
  try {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });

    const calls = [];
    const { media } = makeMedia(
      [
        {
          noteId: "a",
          files: [{ name: "a_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }],
          onCall: () => markStarted(),
          block: firstGate,
        },
        { noteId: "b", files: [{ name: "b_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: "1" }, cwd: root, calls },
    );

    const pendingFirst = media.download({ note_url: "https://xhslink.com/a" });
    await started;
    const firstDir = outputDirOf(calls[0].args);

    await media.download({ note_url: "https://xhslink.com/b" });
    assert.ok(await exists(firstDir), "an in-flight request dir is not reclaimed even when over budget");

    releaseFirst();
    const first = await pendingFirst;
    assert.ok(await exists(first.structuredContent.output_directory), "the returned dir survives its own call");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timed-out call reports an incomplete inventory and stays out of cleanup", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "t1", files: [{ name: "t1_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }], fail: "timeout" },
        { noteId: "t2", files: [{ name: "t2_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: "1" }, cwd: root, calls },
    );

    const timedOut = await media.download({ note_url: "https://xhslink.com/a" });
    const timedOutDir = timedOut.structuredContent.output_directory;
    assert.equal(timedOut.structuredContent.inventory_complete, false, "a killed process may still be writing");
    assert.ok(await exists(timedOutDir));

    await media.download({ note_url: "https://xhslink.com/b" });
    assert.ok(await exists(timedOutDir), "an unconfirmed stop is not reclaimed by a later call");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a settled failure becomes reclaimable by a later call", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "s1", files: [{ name: "s1_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }], fail: true },
        { noteId: "s2", files: [{ name: "s2_1.jpg", bytes: bytesWithMagic(JPEG, 600_000) }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: "1" }, cwd: root, calls },
    );

    const settled = await media.download({ note_url: "https://xhslink.com/a" });
    const settledDir = settled.structuredContent.output_directory;
    assert.equal(settled.structuredContent.inventory_complete, true, "the process exited, so the walk is complete");
    assert.ok(await exists(settledDir));

    await media.download({ note_url: "https://xhslink.com/b" });
    assert.ok(!(await exists(settledDir)), "a confirmed-settled dir is reclaimed once the budget is exceeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image metadata keeps the download root and the signed token private", async () => {
  const root = await tempRoot();
  const token = "XSEC_TOKEN_SECRET_123";
  const noteUrl = `https://www.xiaohongshu.com/explore/abc?xsec_token=${token}`;
  try {
    const { media } = makeMedia(
      [{ noteId: "abc", files: [{ name: "abc_1.jpg", bytes: JPEG }] }],
      { env: {}, cwd: root },
    );

    const images = await media.images({ note_url: noteUrl });
    const download = await media.download({ note_url: noteUrl, output: root });

    const imageMetadata = JSON.stringify(images.structuredContent);
    assert.ok(!imageMetadata.includes(token), "the signed token is never echoed into image metadata");
    assert.ok(!imageMetadata.includes(path.basename(root)), "image metadata never exposes a server-local path");

    const downloadMetadata = JSON.stringify(download.structuredContent);
    assert.ok(!downloadMetadata.includes(token), "the signed token is never echoed into download metadata");
    assert.ok(
      download.structuredContent.files.every((file) => file.local_path.startsWith(path.resolve(root))),
      "download paths stay inside the managed download root",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid cache thresholds are rejected instead of silently defaulting", async () => {
  const root = await tempRoot();
  const cases = [
    ["OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB", "0"],
    ["OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB", "-3"],
    ["OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB", "abc"],
    ["OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES", "0"],
    ["OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES", "1.5"],
  ];
  try {
    for (const [name, value] of cases) {
      const attempt = async () => {
        const { media } = makeMedia(
          [{ noteId: "n1", files: [{ name: "n1_1.jpg", bytes: JPEG }] }],
          { env: { [name]: value }, cwd: root },
        );
        return await media.download({ note_url: "https://xhslink.com/a" });
      };
      const outcome = await attempt().then(() => ({ ok: true }), (error) => ({ ok: false, error }));
      assert.equal(outcome.ok, false, `${name}=${value} must be rejected`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cli_result keeps the sanitized media rows but drops token-bearing diagnostics", async () => {
  const root = await tempRoot();
  const token = "XSEC_SECRET_TOKEN_42";
  const noteUrl = `https://www.xiaohongshu.com/explore/abc?xsec_token=${token}&x=1`;
  try {
    const { media } = makeMedia(
      [
        {
          noteId: "abc",
          files: [{ name: "abc_1.jpg", bytes: JPEG }],
          cliResult: (args) => ({
            ok: true,
            code: 0,
            stdout: `saved 1 file from ${noteUrl}`,
            stderr: `warn: https://xhslink.com/a?xsec_token=${token}`,
            data: [{ index: 1, type: "image", status: "success", url: `https://sns-img.xhscdn.com/p/abc.jpg?xsec_token=${token}` }],
            error: { code: "PARTIAL_MEDIA", message: `one item failed for ${noteUrl}` },
            invocation: { command: "node", args, source: "test fixture" },
            cookie: `a1=${token}`,
            xsec_token: token,
          }),
        },
      ],
      { env: {}, cwd: root },
    );

    const download = await media.download({ note_url: noteUrl });
    const cliResult = download.structuredContent.cli_result;
    const serialized = JSON.stringify(cliResult);

    assert.ok(cliResult, "cli_result is reported");
    assert.ok(!serialized.includes(token), "the raw signed token never survives into cli_result");
    assert.match(serialized, /xsec_token=\[redacted\]/, "query-string tokens are redacted in place");

    for (const field of ["stdout", "stderr", "invocation", "args", "command", "cookie", "xsec_token"]) {
      assert.ok(!Object.hasOwn(cliResult, field), `${field} is stripped from cli_result`);
    }

    assert.ok(Array.isArray(cliResult.data), "the sanitized media rows survive for diagnostics");
    assert.equal(cliResult.data[0].index, 1);
    assert.equal(cliResult.data[0].status, "success");
    assert.equal(cliResult.error.code, "PARTIAL_MEDIA");
    assert.ok(cliResult.error.message.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an image whose filename carries no media index is not given a guessed index", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        {
          noteId: "abc",
          files: [
            { name: "abc_1.jpg", bytes: JPEG },
            { name: "unindexed.jpg", bytes: PNG },
          ],
        },
      ],
      { env: {}, cwd: root },
    );

    const result = await media.images({ note_url: "https://xhslink.com/a", image_indexes: [2] });

    assert.equal(imageBlocks(result).length, 0, "index 2 is not a real media index");
    assert.equal(result.structuredContent.images.length, 0);
    assert.ok(
      result.structuredContent.errors.some((entry) => entry.code === "IMAGE_NOT_FOUND"),
      "the unknown index is reported instead of resolved to an unindexed filename",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("junk bytes behind a .jpg name are never treated as a valid image", async () => {
  const root = await tempRoot();
  try {
    const junk = Buffer.from("this is definitely not image data");
    const { media } = makeMedia(
      [{ noteId: "abc", files: [{ name: "abc_1.jpg", bytes: junk }] }],
      { env: {}, cwd: root },
    );

    const download = await media.download({ note_url: "https://xhslink.com/a" });
    assert.equal(download.structuredContent.files.length, 1);
    assert.ok(
      !download.structuredContent.files[0].mime_type.startsWith("image/"),
      "MIME comes from the bytes, not the extension",
    );

    const images = await media.images({ note_url: "https://xhslink.com/a" });
    assert.equal(imageBlocks(images).length, 0);
    assert.equal(images.structuredContent.images.length, 0);
    assert.ok(images.structuredContent.errors.length >= 1, "the unusable file is reported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("temp-file bytes count toward the size budget even though inventory excludes them", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        { noteId: "t1", files: [{ name: "t1_1.jpg.tmp", size: 900_000 }] },
        { noteId: "t2", files: [{ name: "t2_1.jpg", bytes: bytesWithMagic(JPEG, 900_000) }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: "1" }, cwd: root },
    );

    const first = await media.download({ note_url: "https://xhslink.com/a" });
    const firstDir = first.structuredContent.output_directory;
    assert.equal(first.structuredContent.files.length, 0, "temp files stay out of the inventory");
    assert.ok(await exists(firstDir));

    await media.download({ note_url: "https://xhslink.com/b" });
    assert.ok(!(await exists(firstDir)), "temp bytes still count against the shared budget");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an image task left with no images is pruned, not kept as an empty directory", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [{ noteId: "v1", files: [{ name: "v1_1.mp4", bytes: MP4 }] }],
      { env: {}, cwd: root, calls },
    );

    const result = await media.images({ note_url: "https://xhslink.com/a" });
    assert.equal(imageBlocks(result).length, 0);

    const taskDir = outputDirOf(calls.at(-1).args);
    assert.ok(!(await exists(taskDir)), "an image task holding only non-image products is reclaimed");
    assert.ok(await exists(path.join(root, IMAGE_CACHE_DIR)), "the container itself stays");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a confirmed timeout flags the inventory incomplete but still salvages files and images", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        { noteId: "c1", files: [{ name: "c1_1.jpg", bytes: JPEG }], fail: "timeout_confirmed" },
        { noteId: "c2", files: [{ name: "c2_1.jpg", bytes: JPEG }], fail: "timeout_confirmed" },
      ],
      { env: {}, cwd: root },
    );

    const download = await media.download({ note_url: "https://xhslink.com/a" });
    assert.equal(download.structuredContent.inventory_complete, false);
    assert.equal(download.structuredContent.status, "partial");
    assert.equal(download.structuredContent.files.length, 1, "verified files are salvaged after a confirmed stop");

    const images = await media.images({ note_url: "https://xhslink.com/a" });
    assert.equal(imageBlocks(images).length, 1, "confirmed stops still allow image salvage");
    assert.equal(images.structuredContent.inventory_complete, false);
    assert.equal(images.structuredContent.status, "partial");
    assert.ok(images.structuredContent.errors.some((entry) => entry.code === "CLI_ERROR"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("row-level CLI failures surface as partial with the failed index reported", async () => {
  const root = await tempRoot();
  const rows = [
    { index: 1, type: "image", status: "failed", size: "error" },
    { index: 2, type: "image", status: "success" },
  ];
  try {
    const { media } = makeMedia(
      [
        { noteId: "note", files: [{ name: "note_2.jpg", bytes: JPEG }], cliData: rows },
        { noteId: "note", files: [{ name: "note_2.jpg", bytes: JPEG }], cliData: rows },
      ],
      { env: {}, cwd: root },
    );

    const download = await media.download({ note_url: "https://xhslink.com/a" });
    assert.equal(download.structuredContent.status, "partial", "an exit-0 row failure is not a clean success");
    assert.equal(download.structuredContent.files.length, 1);

    const images = await media.images({ note_url: "https://xhslink.com/a" });
    assert.equal(images.structuredContent.status, "partial");
    assert.equal(imageBlocks(images).length, 1);
    assert.deepEqual(images.structuredContent.images.map((image) => image.index), [2]);
    assert.ok(
      images.structuredContent.errors.some((entry) => entry.index === 1 && entry.code === "IMAGE_DOWNLOAD_FAILED"),
      "the failed row is reported against its own media index",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CLI result with no rows and no files is an error, not a success", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [
        { noteId: "note", files: [], cliData: [] },
        { noteId: "note", files: [], cliData: [] },
      ],
      { env: {}, cwd: root },
    );

    const download = await media.download({ note_url: "https://xhslink.com/a" });
    assert.equal(download.structuredContent.status, "error");
    assert.equal(download.structuredContent.files.length, 0);

    const images = await media.images({ note_url: "https://xhslink.com/a" });
    assert.notEqual(images.structuredContent.status, "success");
    assert.equal(images.structuredContent.images.length, 0);
    assert.ok(images.structuredContent.errors.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runImages() parses argv, keeps signed URLs intact, and answers --help without a CLI call", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [{ noteId: "abc123", files: [{ name: "abc123_1.jpg", bytes: JPEG }, { name: "abc123_3.png", bytes: PNG }], cliData: [] }],
      { env: { OPENCLI_XIAOHONGSHU_IMAGE_BLOCKS_PER_RESPONSE: "20" }, cwd: root, calls },
    );

    const help = await media.runImages(["--help"]);
    assert.equal(help.structuredContent.status, "success");
    assert.match(help.structuredContent.help, /command="images"/);
    assert.equal(calls.length, 0, "help must not invoke the CLI");

    const signed = "https://www.xiaohongshu.com/explore/abc123?xsec_token=AB==&xsec_source=pc_share";
    const result = await media.runImages([signed, "--indexes", "1, 3", "--timeout-ms", "120000"]);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.images.map((image) => image.index), [1, 3]);
    assert.equal(imageBlocks(result).length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], signed, "the signed URL must reach the CLI untouched");
    assert.ok(!calls[0].args.includes("120000"), "the MCP-only timeout must not be forwarded to the CLI");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runImages() rejects output, duplicate indexes, unknown flags, and bad values before running the CLI", async () => {
  const root = await tempRoot();
  try {
    const { media, calls } = makeMedia([], { env: {}, cwd: root });
    const url = "https://xhslink.com/a";

    await assert.rejects(() => media.runImages([url, "--output", root]), /does not accept output/);
    await assert.rejects(() => media.runImages([url, "-o", root]), /does not accept output/);
    await assert.rejects(() => media.runImages([url, "--index", "2", "--index", "2"]), /Duplicate media index/);
    await assert.rejects(() => media.runImages([url, "--nope"]), /Unsupported images argument/);
    await assert.rejects(() => media.runImages([url, "--indexes", "0"]), /positive integer/);
    await assert.rejects(() => media.runImages([url, "--timeout-ms", "600001"]), /at most 600000/);
    await assert.rejects(() => media.runImages([url, "--format", "json"]), /Conflicting format arguments/);

    assert.equal(calls.length, 0, "argument errors must not reach the CLI");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed media row surfaces the CLI reason, the available indexes, and a top-level error", async () => {
  const root = await tempRoot();
  const rows = [
    { index: 1, type: "image", status: "success", size: "54 KB" },
    { index: 2, type: "image", status: "failed", size: "HTTP 403 Forbidden" },
  ];
  try {
    const { media } = makeMedia(
      [{ noteId: "note", files: [{ name: "note_1.jpg", bytes: JPEG }], cliData: rows }],
      { env: {}, cwd: root },
    );

    const images = await media.images({ note_url: "https://xhslink.com/a", image_indexes: [2] });

    assert.equal(images.structuredContent.status, "error");
    const failed = images.structuredContent.errors.find((entry) => entry.code === "IMAGE_DOWNLOAD_FAILED");
    assert.equal(failed.index, 2);
    assert.equal(failed.detail, "HTTP 403 Forbidden", "the CLI reason travels with the failed media row");
    assert.match(failed.message, /HTTP 403 Forbidden/);
    assert.equal(images.structuredContent.error.code, "IMAGE_DOWNLOAD_FAILED");
    assert.match(images.structuredContent.error.message, /HTTP 403 Forbidden/);
    assert.deepEqual(images.structuredContent.available_indexes, [1]);
    assert.equal(images.structuredContent.note_id, "note");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CLI-level failure forwards the CLI message and error code instead of a generic sentence", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia([{ noteId: "note", files: [], fail: true }], { env: {}, cwd: root });

    const images = await media.images({ note_url: "https://xhslink.com/a" });

    assert.equal(images.structuredContent.status, "error");
    assert.equal(images.structuredContent.error.code, "CLI_ERROR");
    assert.match(images.structuredContent.error.message, /note unavailable/);
    assert.equal(images.structuredContent.error.cli_error_code, "XHS_NOTE_ERROR");
    assert.equal(images.structuredContent.error.exit_code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the media wrapper always parses JSON even when the caller asks for another format", async () => {
  const root = await tempRoot();
  const rows = [
    { index: 1, type: "image", status: "failed", size: "HTTP 403 Forbidden" },
    { index: 2, type: "image", status: "success", size: "54 KB" },
  ];
  try {
    const calls = [];
    const { media } = makeMedia(
      [{ noteId: "note", files: [{ name: "note_2.jpg", bytes: JPEG }], cliData: rows }],
      { env: {}, cwd: root, calls },
    );

    const download = await media.runDownload(["https://xhslink.com/a", "--output", root], { format: "table" });

    assert.deepEqual(calls[0].args.slice(-2), ["-f", "json"], "a table format would hide the per-media failure rows");
    assert.equal(download.structuredContent.status, "partial");
    assert.equal(download.structuredContent.error.code, "MEDIA_DOWNLOAD_FAILED");
    assert.deepEqual(download.structuredContent.error.failed_indexes, [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a requested index that has no image reports which indexes do exist", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [{ noteId: "note", files: [{ name: "note_1.jpg", bytes: JPEG }, { name: "note_3.png", bytes: PNG }] }],
      { env: {}, cwd: root },
    );

    const images = await media.images({ note_url: "https://xhslink.com/a", image_indexes: [2] });

    assert.equal(images.structuredContent.status, "error");
    const missing = images.structuredContent.errors.find((entry) => entry.code === "IMAGE_NOT_FOUND");
    assert.equal(missing.index, 2);
    assert.deepEqual(missing.available_indexes, [1, 3]);
    assert.match(missing.message, /available image indexes: 1, 3/);
    assert.match(images.structuredContent.error.message, /available image indexes: 1, 3/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a download with a failed media row reports a top-level error with the CLI reason", async () => {
  const root = await tempRoot();
  try {
    const { media } = makeMedia(
      [{
        noteId: "note",
        files: [{ name: "note_1.jpg", bytes: JPEG }],
        cliData: [{ index: 1, type: "image", status: "failed", size: "HTTP 403 Forbidden" }],
      }],
      { env: {}, cwd: root },
    );

    const download = await media.download({ note_url: "https://xhslink.com/a" });

    assert.equal(download.structuredContent.status, "partial");
    assert.equal(download.structuredContent.error.code, "MEDIA_DOWNLOAD_FAILED");
    assert.match(download.structuredContent.error.message, /HTTP 403 Forbidden/);
    assert.deepEqual(download.structuredContent.error.failed_indexes, [1]);
    assert.equal(download.structuredContent.files.length, 1, "verified files are still returned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failure text keeps server-local paths while the signed token stays redacted", async () => {
  const root = await tempRoot();
  const token = "AB==CD";
  const signed = `https://www.xiaohongshu.com/explore/abc123?xsec_token=${encodeURIComponent(token)}`;
  const serverPath = "C:\\Users\\dev\\AppData\\Local\\opencli-xhs\\opencli-xhs-images\\opencli-xhs-1\\abc123\\abc123_2.jpg";
  try {
    const { media } = makeMedia(
      [{
        noteId: "abc123",
        files: [{ name: "abc123_1.jpg", bytes: JPEG }],
        cliData: [{ index: 2, type: "image", status: "failed", size: `HTTP 403 while writing ${serverPath} (token ${token})` }],
      }],
      { env: {}, cwd: root },
    );

    const images = await media.images({ note_url: signed, image_indexes: [2] });

    const failed = images.structuredContent.errors.find((entry) => entry.code === "IMAGE_DOWNLOAD_FAILED");
    assert.ok(
      failed.detail.includes(serverPath),
      "a server-local path in the CLI reason is diagnosis, not a secret, so it stays visible",
    );
    assert.ok(!failed.detail.includes(token), "the signed token is still redacted");
    assert.ok(!images.structuredContent.error.message.includes(token));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runImages() reports the navigation retry in its own payload", async () => {
  const root = await tempRoot();
  try {
    const calls = [];
    const { media } = makeMedia(
      [
        { noteId: "n1", files: [], throws: navigationRejected() },
        { noteId: "n1", files: [{ name: "n1_1.jpg", bytes: PNG }] },
      ],
      { env: { OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root }, cwd: root, calls },
    );

    const result = await media.runImages(["https://xhslink.com/a", "--indexes", "1"]);

    assert.equal(result.structuredContent.status, "success");
    assert.deepEqual(result.structuredContent.retry, {
      reason: "navigation_rejected",
      attempts: 2,
      session: "persistent",
      outcome: "success",
    });
    assert.equal(imageBlocks(result).length, 1);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
