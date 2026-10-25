import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
