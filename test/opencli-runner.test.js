import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyBin,
  createOpenCliRunner,
  describeOpenCliCandidates,
  OpenCliError,
  OpenCliResolutionError,
  parseOpenCliOutput,
  resolveOpenCli,
} from "../src/opencli-runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "echo-argv.js");

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "opencli-runner-"));
}

function writeOpenCliPackage(packageDir, bin = "dist/src/main.js") {
  mkdirSync(path.join(packageDir, "dist", "src"), { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@jackwener/opencli", version: "1.8.8", bin: { opencli: bin } }),
  );
  writeFileSync(path.join(packageDir, bin), "// opencli stub\n");
}

test("parses JSON and plain text", () => {
  assert.deepEqual(parseOpenCliOutput('{"ok":true}'), { ok: true });
  assert.equal(parseOpenCliOutput("OpenCLI 1.0.0"), "OpenCLI 1.0.0");
  assert.equal(parseOpenCliOutput("  "), null);
});

test("runner passes arguments without a shell", async () => {
  const run = createOpenCliRunner({
    resolved: {
      command: process.execPath,
      prefixArgs: [fixture],
      source: "test fixture",
    },
  });
  const dangerous = '中文 "quoted" & echo PWNED';
  const result = await run(["browser", "demo", "fill", "#input", dangerous]);
  assert.deepEqual(result.data, ["browser", "demo", "fill", "#input", dangerous]);
  assert.equal(result.stderr, "");
});

test("a per-call env overrides the runner environment for that invocation only", async () => {
  const run = createOpenCliRunner({
    resolved: {
      command: process.execPath,
      prefixArgs: ["-e", "process.stdout.write(JSON.stringify({ session: process.env.OPENCLI_SITE_SESSION ?? null, hasPath: Boolean(process.env.PATH || process.env.Path) }))"],
      source: "test fixture",
    },
    env: { ...process.env, OPENCLI_SITE_SESSION: "process-default" },
  });

  const first = await run(["noop"]);
  assert.equal(first.data.session, "process-default");

  const overridden = await run(["noop"], { env: { OPENCLI_SITE_SESSION: "per-call" } });
  assert.equal(overridden.data.session, "per-call");
  assert.equal(overridden.data.hasPath, true, "a per-call override merges into the runner env");

  const last = await run(["noop"]);
  assert.equal(last.data.session, "process-default", "the runner environment is not mutated");
});

test("a Windows per-call override replaces the same key regardless of casing", { skip: process.platform !== "win32" }, async () => {
  const run = createOpenCliRunner({
    resolved: {
      command: process.execPath,
      prefixArgs: ["-e", "process.stdout.write(JSON.stringify({ keys: Object.keys(process.env).filter(k => k.toLowerCase() === 'opencli_case_probe'), value: process.env.OPENCLI_CASE_PROBE ?? null }))"],
      source: "test fixture",
    },
    env: { ...process.env, OPENCLI_CASE_PROBE: "base" },
  });

  const result = await run(["noop"], { env: { opencli_case_probe: "override" } });

  assert.equal(result.data.value, "override");
  assert.equal(result.data.keys.length, 1, "Windows must not receive both casings of the same key");
});

test("runner returns structured process errors", async () => {
  const run = createOpenCliRunner({
    resolved: {
      command: process.execPath,
      prefixArgs: [fixture, "--fail"],
      source: "test fixture",
    },
  });
  await assert.rejects(
    run(["bad"]),
    (error) => error instanceof OpenCliError && error.details.code === 7,
  );
});

// --- termination lifecycle: stop the whole tree, confirm it, keep partial data ---

// Spawns a grandchild that inherits the stdout pipe and lingers ~3s. A parent-only
// kill leaves that grandchild holding the pipe, so 'close' would not fire promptly.
const HOLD_STDOUT_PIPE_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "inherit" });',
  "setInterval(() => {}, 1000);",
].join(" ");

const PARTIAL_THEN_SPAM_SCRIPT = [
  'process.stdout.write("DOWNLOADED:note-123;");',
  "setTimeout(() => {",
  '  const chunk = "x".repeat(4096);',
  "  setInterval(() => process.stdout.write(chunk), 2);",
  "}, 30);",
].join(" ");

test("timeout stops the whole process tree before rejecting", async () => {
  const run = createOpenCliRunner({
    resolved: {
      command: process.execPath,
      prefixArgs: ["-e", HOLD_STDOUT_PIPE_SCRIPT],
      source: "test fixture",
    },
    timeoutMs: 150,
    killGraceMs: 100,
    killDeadlineMs: 2_000,
  });

  const startedAt = Date.now();
  await assert.rejects(run([]), (error) => {
    assert.ok(error instanceof OpenCliError);
    assert.equal(error.details.code, "TIMEOUT");
    assert.equal(error.details.termination_confirmed, true);
    // exit_code/signal are only known once the child actually closed.
    assert.equal("exit_code" in error.details, true);
    assert.equal("signal" in error.details, true);
    return true;
  });

  // A parent-only kill would wait ~3s on the orphaned grandchild's pipe.
  assert.ok(Date.now() - startedAt < 2_000, "runner waited on an orphaned grandchild");
});

test("output limit rejects after close and preserves partial stdout", async () => {
  const run = createOpenCliRunner({
    resolved: {
      command: process.execPath,
      prefixArgs: ["-e", PARTIAL_THEN_SPAM_SCRIPT],
      source: "test fixture",
    },
    maxOutputBytes: 1_024,
    timeoutMs: 5_000,
    killGraceMs: 100,
    killDeadlineMs: 2_000,
  });

  await assert.rejects(run([]), (error) => {
    assert.ok(error instanceof OpenCliError);
    assert.equal(error.details.code, "OUTPUT_LIMIT");
    assert.equal(error.details.partial, true);
    assert.equal(error.details.termination_confirmed, true);
    assert.equal(error.details.stdout.startsWith("DOWNLOADED:note-123;"), true);
    return true;
  });
});

test("termination_confirmed stays false when a tree stop cannot be proven", async () => {
  const run = createOpenCliRunner({
    resolved: {
      command: process.execPath,
      prefixArgs: ["-e", "setInterval(() => {}, 1000);"],
      source: "test fixture",
    },
    timeoutMs: 120,
    killGraceMs: 60,
    killDeadlineMs: 1_500,
    killTree: () => "failed",
  });

  await assert.rejects(run([]), (error) => {
    assert.equal(error.details.code, "TIMEOUT");
    assert.equal(error.details.termination_confirmed, false);
    return true;
  });
});

// POSIX only: a descendant that ignores SIGTERM and redirected its stdio keeps
// writing after the parent closes. Confirmation must force-kill the group.
// (Descendants that leave the group via setsid/detached are out of scope.)
function ignoreTermWriterScript(file) {
  const grandchild = [
    'process.on("SIGTERM", () => {});',
    'const fs = require("node:fs");',
    `const fd = fs.openSync(${JSON.stringify(file)}, "a");`,
    'setInterval(() => fs.writeSync(fd, "tick"), 40);',
  ].join("");
  return [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const out = fs.openSync(${JSON.stringify(file)}, "a");`,
    `spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", out, out] }).unref();`,
    "setInterval(() => {}, 1000);",
  ].join("");
}

test(
  "a SIGTERM-ignoring descendant keeps the stop unconfirmed until it is killed",
  { skip: process.platform === "win32" },
  async () => {
    const dir = makeTempRoot();
    const marker = path.join(dir, "ticks.txt");
    try {
      const run = createOpenCliRunner({
        resolved: {
          command: process.execPath,
          prefixArgs: ["-e", ignoreTermWriterScript(marker)],
          source: "test fixture",
        },
        timeoutMs: 200,
        killGraceMs: 120,
        killDeadlineMs: 2_000,
      });

      await assert.rejects(run([]), (error) => {
        assert.equal(error.details.code, "TIMEOUT");
        assert.equal(error.details.termination_confirmed, true);
        return true;
      });

      assert.equal(existsSync(marker), true, "descendant never wrote before the stop");
      const sizeAfterStop = statSync(marker).size;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(
        statSync(marker).size,
        sizeAfterStop,
        "descendant kept writing after a confirmed stop",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("runner falls back to options.cwd and still honors a per-call cwd", async () => {
  const baseDir = makeTempRoot();
  const callDir = makeTempRoot();
  try {
    const run = createOpenCliRunner({
      resolved: {
        command: process.execPath,
        prefixArgs: ["-e", "process.stdout.write(process.cwd())"],
        source: "test fixture",
      },
      cwd: baseDir,
    });

    const fallback = await run([]);
    assert.equal(realpathSync(fallback.stdout.trim()), realpathSync(baseDir));

    const overridden = await run([], { cwd: callDir });
    assert.equal(realpathSync(overridden.stdout.trim()), realpathSync(callDir));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(callDir, { recursive: true, force: true });
  }
});

test("runner resolves a relative JavaScript env entrypoint from options.cwd", async () => {
  const root = makeTempRoot();
  const callDir = makeTempRoot();
  try {
    const jsFile = path.join(root, "cli.js");
    writeFileSync(jsFile, "console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));");
    const run = createOpenCliRunner({
      cwd: root,
      env: { ...process.env, OPENCLI_MCP_BIN: "./cli.js", OPENCLI_MCP_PREFIX_ARGS: '["--fixture"]' },
    });

    const result = await run(["probe"]);
    assert.equal(realpathSync(result.data.cwd), realpathSync(root));
    assert.deepEqual(result.data.args, ["--fixture", "probe"]);
    assert.equal(realpathSync(result.invocation.args[0]), realpathSync(jsFile));

    const overridden = await run([], { cwd: callDir });
    assert.equal(realpathSync(overridden.data.cwd), realpathSync(callDir));
    assert.equal(realpathSync(overridden.invocation.args[0]), realpathSync(jsFile));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(callDir, { recursive: true, force: true });
  }
});

test("runner finds a parent project config from options.cwd and resolves its relative JavaScript bin", async () => {
  const root = makeTempRoot();
  try {
    const nested = path.join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const jsFile = path.join(root, "cli.js");
    writeFileSync(jsFile, "console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));");
    writeFileSync(path.join(root, ".opencli-mcp.json"), JSON.stringify({ bin: "./cli.js", prefixArgs: ["--project"] }));
    const { OPENCLI_MCP_BIN, OPENCLI_MCP_PREFIX_ARGS, ...env } = process.env;
    const run = createOpenCliRunner({ cwd: nested, env });

    const result = await run(["probe"]);
    assert.equal(realpathSync(result.data.cwd), realpathSync(nested));
    assert.deepEqual(result.data.args, ["--project", "probe"]);
    assert.equal(realpathSync(result.invocation.args[0]), realpathSync(jsFile));
    assert.equal(result.invocation.source, `.opencli-mcp.json (${path.join(root, ".opencli-mcp.json")})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner exposes a non-enumerable executionPlatform hint", () => {
  const native = createOpenCliRunner({
    resolved: { command: process.execPath, prefixArgs: [], source: "test" },
  });
  assert.equal(native.executionPlatform, process.platform);
  assert.equal(Object.keys(native).includes("executionPlatform"), false);

  // A mounted Windows node.exe (WSL -> Windows) must report win32, not the host OS.
  const crossOs = createOpenCliRunner({
    resolved: {
      command: "C:\\Users\\dev\\AppData\\Roaming\\fnm\\node-versions\\v20.11.0\\installation\\node.exe",
      prefixArgs: [],
      source: "WSL -> Windows Node",
    },
  });
  assert.equal(crossOs.executionPlatform, "win32");
});

// --- P0: npm global / PATH auto-discovery ---

test("resolveOpenCli discovers an npm global install next to the Node binary", () => {
  const root = makeTempRoot();
  try {
    const execPath = path.join(root, "nodejs", "node.exe");
    const packageDir = path.join(root, "nodejs", "node_modules", "@jackwener", "opencli");
    writeOpenCliPackage(packageDir);

    const resolved = resolveOpenCli(
      { PATH: "" },
      { execPath, platform: "win32", cwd: root, homedir: path.join(root, "home") },
    );

    assert.equal(resolved.command, execPath);
    assert.deepEqual(resolved.prefixArgs, [path.join(packageDir, "dist", "src", "main.js")]);
    assert.equal(resolved.source, `npm global (${packageDir})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveOpenCli discovers an npm global install from a PATH entry", () => {
  const root = makeTempRoot();
  try {
    const execPath = path.join(root, "other", "node.exe");
    const pathDir = path.join(root, "custom-bin");
    const packageDir = path.join(pathDir, "node_modules", "@jackwener", "opencli");
    writeOpenCliPackage(packageDir);

    const resolved = resolveOpenCli(
      { PATH: pathDir },
      { execPath, platform: "win32", cwd: root, homedir: path.join(root, "home") },
    );

    assert.equal(resolved.source, `npm global (${packageDir})`);
    assert.deepEqual(resolved.prefixArgs, [path.join(packageDir, "dist", "src", "main.js")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveOpenCli reads the bin entry declared by package.json instead of hardcoding a path", () => {
  const root = makeTempRoot();
  try {
    const execPath = path.join(root, "nodejs", "node.exe");
    const packageDir = path.join(root, "nodejs", "node_modules", "@jackwener", "opencli");
    writeOpenCliPackage(packageDir, "dist/src/other-entry.js");

    const resolved = resolveOpenCli(
      { PATH: "" },
      { execPath, platform: "win32", cwd: root, homedir: path.join(root, "home") },
    );

    assert.deepEqual(resolved.prefixArgs, [path.join(packageDir, "dist", "src", "other-entry.js")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- P1: override simplification ---

test("resolveOpenCli runs a .js OPENCLI_MCP_BIN through the current Node and appends prefix args", () => {
  const root = makeTempRoot();
  try {
    const jsFile = path.join(root, "dist", "main.js");
    const resolved = resolveOpenCli(
      { OPENCLI_MCP_BIN: jsFile, OPENCLI_MCP_PREFIX_ARGS: '["--flag","a b"]' },
      { execPath: process.execPath, platform: "win32", cwd: root },
    );

    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.prefixArgs, [path.resolve(jsFile), "--flag", "a b"]);
    assert.equal(resolved.source, "OPENCLI_MCP_BIN (js-file)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifyBin rejects Windows shell shims with an actionable message", () => {
  const deps = {
    platform: "win32",
    execPath: process.execPath,
    cwd: process.cwd(),
    env: { PATH: "" },
    existsSync: () => false,
  };

  assert.throws(
    () => classifyBin("C:\\Program Files\\nodejs\\opencli.cmd", deps),
    (error) => /opencli\.cmd/.test(error.message) && /OPENCLI_MCP_PREFIX_ARGS/.test(error.message),
  );

  assert.throws(
    () => resolveOpenCli(
      { OPENCLI_MCP_BIN: "opencli", PATH: "" },
      { platform: "win32", env: { PATH: "", PATHEXT: ".EXE" }, existsSync: () => false },
    ),
    /shell shim/,
  );
});

test("classifyBin resolves a bare Windows command through PATH and PATHEXT", () => {
  const target = path.join("C:\\tools", "node.EXE");
  const deps = {
    platform: "win32",
    execPath: process.execPath,
    cwd: process.cwd(),
    env: { PATH: "C:\\tools", PATHEXT: ".EXE" },
    existsSync: (candidate) => String(candidate).toLowerCase() === target.toLowerCase(),
  };

  const resolved = classifyBin("node", deps);
  assert.equal(resolved.command.toLowerCase(), target.toLowerCase());
  assert.deepEqual(resolved.prefixArgs, []);
});

test("classifyBin treats a non-Windows bare command as native", () => {
  const deps = {
    platform: "linux",
    execPath: "/usr/bin/node",
    cwd: "/work",
    env: { PATH: "/usr/bin" },
    existsSync: () => false,
  };
  assert.deepEqual(classifyBin("opencli", deps), { command: "opencli", prefixArgs: [], kind: "command" });
});

// --- P1: project config file ---

test("resolveOpenCli uses .opencli-mcp.json found above cwd, and env wins over it", () => {
  const root = makeTempRoot();
  try {
    const jsFile = path.join(root, "main.js");
    writeFileSync(jsFile, "// stub\n");
    const nested = path.join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const configPath = path.join(root, ".opencli-mcp.json");
    writeFileSync(configPath, JSON.stringify({ bin: jsFile }));

    const base = {
      execPath: process.execPath,
      platform: "win32",
      cwd: nested,
      homedir: path.join(root, "home"),
    };

    const fromConfig = resolveOpenCli({ PATH: "" }, base);
    assert.equal(fromConfig.source, `.opencli-mcp.json (${configPath})`);
    assert.deepEqual(fromConfig.prefixArgs, [path.resolve(jsFile)]);

    const otherJs = path.join(root, "other.js");
    writeFileSync(otherJs, "// stub\n");
    const fromEnv = resolveOpenCli({ OPENCLI_MCP_BIN: otherJs, PATH: "" }, base);
    assert.equal(fromEnv.source, "OPENCLI_MCP_BIN (js-file)");
    assert.deepEqual(fromEnv.prefixArgs, [path.resolve(otherJs)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveOpenCli throws a clear error for an invalid config file", () => {
  const root = makeTempRoot();
  try {
    writeFileSync(path.join(root, ".opencli-mcp.json"), "{ not json");
    assert.throws(
      () => resolveOpenCli(
        { PATH: "" },
        { execPath: process.execPath, platform: "win32", cwd: root, homedir: path.join(root, "home") },
      ),
      /is not valid JSON/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- P2: diagnostics ---

test("resolveOpenCli reports probed candidates when nothing is found", () => {
  const root = makeTempRoot();
  try {
    const execPath = path.join(root, "nodejs", "node.exe");
    const overrides = { execPath, platform: "win32", cwd: root, homedir: path.join(root, "home") };

    assert.throws(
      () => resolveOpenCli({ PATH: "" }, overrides),
      (error) =>
        error instanceof OpenCliResolutionError &&
        Array.isArray(error.candidates) &&
        error.candidates.length > 0 &&
        /Probed candidates/.test(error.message),
    );

    const candidates = describeOpenCliCandidates({ PATH: "" }, overrides);
    assert.ok(candidates.some((line) => line.includes("@jackwener")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
