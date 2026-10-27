import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
// Grace period between the soft stop signal and the forced process-tree kill.
const DEFAULT_KILL_GRACE_MS = 2_000;
// Hard ceiling for observing closure before the runner gives up and reports an
// unconfirmed stop. Kept above the grace period so SIGKILL has time to land.
const DEFAULT_KILL_DEADLINE_MS = 5_000;
// Bound for `taskkill` and for polling a POSIX process group until it is empty.
const TASKKILL_TIMEOUT_MS = 5_000;
const TREE_PROBE_TIMEOUT_MS = 750;
const TREE_PROBE_INTERVAL_MS = 25;
const CONFIG_FILE_NAME = ".opencli-mcp.json";
const OPENCLI_PACKAGE = ["@jackwener", "opencli"];
const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];
const SHELL_SHIM_EXTENSIONS = [".ps1", ".cmd", ".bat"];
const WINDOWS_EXECUTABLE = /\.exe$/i;

export class OpenCliResolutionError extends Error {
  constructor(message, candidates = []) {
    super(message);
    this.name = "OpenCliResolutionError";
    this.candidates = candidates;
  }
}

function defaultDeps(env) {
  return {
    env,
    platform: process.platform,
    execPath: process.execPath,
    cwd: process.cwd(),
    homedir: os.homedir(),
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
  };
}

/**
 * Resolve how the OpenCLI CLI should be launched.
 *
 * Priority: OPENCLI_MCP_BIN (env) > .opencli-mcp.json (project config) >
 * auto-discovery (OpenCLIApp bundle, npm global installs, WSL -> Windows fnm).
 *
 * Always returns { command, prefixArgs, source } and keeps the shell:false +
 * separate-argv design so no MCP string ever passes through a shell.
 */
export function resolveOpenCli(env = process.env, overrides = {}) {
  const deps = { ...defaultDeps(env), ...overrides };

  if (env.OPENCLI_MCP_BIN) {
    const classified = classifyBin(env.OPENCLI_MCP_BIN, deps);
    return {
      command: classified.command,
      prefixArgs: [...classified.prefixArgs, ...parsePrefixArgs(env.OPENCLI_MCP_PREFIX_ARGS)],
      source: `OPENCLI_MCP_BIN (${classified.kind})`,
    };
  }

  const config = findProjectConfig(deps);
  if (config) {
    const rawBin = config.data.bin ?? config.data.command;
    if (typeof rawBin !== "string" || rawBin.trim() === "") {
      throw new Error(`${config.path} must contain a non-empty "bin" string.`);
    }
    const prefixArgs = config.data.prefixArgs ?? [];
    if (!Array.isArray(prefixArgs) || prefixArgs.some((item) => typeof item !== "string")) {
      throw new Error(`${config.path} "prefixArgs" must be a JSON string array.`);
    }
    // Relative JavaScript entrypoints belong to the configuration file, so a
    // parent or home-directory config also works when invoked from a child cwd.
    const classified = classifyBin(rawBin, { ...deps, cwd: path.dirname(config.path) });
    return {
      command: classified.command,
      prefixArgs: [...classified.prefixArgs, ...prefixArgs],
      source: `${CONFIG_FILE_NAME} (${config.path})`,
    };
  }

  const candidates = [];
  const discovered = discoverOpenCli(deps, candidates);
  if (discovered) return discovered;

  throw new OpenCliResolutionError(buildNotFoundMessage(candidates), candidates);
}

/**
 * List the auto-discovery locations that were probed, with a short reason for
 * each miss. Used as diagnostics when resolution fails.
 */
export function describeOpenCliCandidates(env = process.env, overrides = {}) {
  const deps = { ...defaultDeps(env), ...overrides };
  const candidates = [];
  try {
    discoverOpenCli(deps, candidates);
  } catch {
    // Candidate probing is best-effort diagnostics only.
  }
  return candidates;
}

/**
 * Classify a user-supplied entrypoint so a .js file runs through the current
 * Node runtime while Windows shell shims fail fast with an actionable message.
 */
export function classifyBin(bin, deps = defaultDeps(process.env)) {
  const value = String(bin);
  const hasSeparator = /[\\/]/.test(value);
  const ext = path.extname(value).toLowerCase();

  if (!hasSeparator) {
    if (JS_EXTENSIONS.includes(ext)) {
      return {
        command: deps.execPath,
        prefixArgs: [path.resolve(deps.cwd ?? process.cwd(), value)],
        kind: "js-file",
      };
    }
    if (deps.platform !== "win32") return { command: value, prefixArgs: [], kind: "command" };
    const resolved = resolveOnWindowsPath(value, deps);
    if (resolved && !isShimExtension(path.extname(resolved))) {
      return { command: resolved, prefixArgs: [], kind: "command" };
    }
    throw new Error(shimMessage(bin, resolved));
  }

  if (JS_EXTENSIONS.includes(ext)) {
    return {
      command: deps.execPath,
      prefixArgs: [path.resolve(deps.cwd ?? process.cwd(), value)],
      kind: "js-file",
    };
  }
  if (isShimExtension(ext)) throw new Error(shimMessage(bin));
  if (deps.platform === "win32" && ext === "") throw new Error(shimMessage(bin));
  return { command: value, prefixArgs: [], kind: "executable" };
}

function isShimExtension(ext) {
  return SHELL_SHIM_EXTENSIONS.includes(String(ext).toLowerCase());
}

function shimMessage(bin, resolved) {
  const target = resolved ? ` (${resolved})` : "";
  return (
    `OPENCLI_MCP_BIN "${bin}"${target} is a Windows shell shim, which cannot be executed with ` +
    `shell:false (Windows raises spawn EFTYPE). Point it at the package's JavaScript entrypoint ` +
    `instead, e.g. OPENCLI_MCP_BIN=<path>\\node_modules\\@jackwener\\opencli\\dist\\src\\main.js ` +
    `(a .js value runs through the current Node), or use OPENCLI_MCP_BIN=node with ` +
    `OPENCLI_MCP_PREFIX_ARGS='["<path to dist/src/main.js>"]', or unset it to use auto-discovery.`
  );
}

function resolveOnWindowsPath(name, deps) {
  const pathValue = deps.env?.PATH ?? deps.env?.Path ?? "";
  const extensions = String(deps.env?.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const rawDir of String(pathValue).split(path.delimiter)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const extension of ["", ...extensions]) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (deps.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findProjectConfig(deps) {
  const dirs = [];
  let current = path.resolve(deps.cwd ?? process.cwd());
  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (deps.homedir) dirs.push(path.resolve(deps.homedir));

  const seen = new Set();
  for (const dir of dirs) {
    const key = deps.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = path.join(dir, CONFIG_FILE_NAME);
    if (!deps.existsSync(file)) continue;

    let text;
    try {
      text = deps.readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`Failed to read ${file}: ${error.message}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${error.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`${file} must contain a JSON object like { "bin": "...", "prefixArgs": [] }.`);
    }
    return { path: file, data };
  }
  return null;
}

function discoverOpenCli(deps, candidates) {
  if (deps.platform === "win32") {
    const localAppData = deps.env?.LOCALAPPDATA;
    if (localAppData) {
      const appMain = path.join(
        localAppData,
        "OpenCLIApp",
        "node_modules",
        ...OPENCLI_PACKAGE,
        "dist",
        "src",
        "main.js",
      );
      if (deps.existsSync(appMain)) {
        return {
          command: deps.execPath,
          prefixArgs: [appMain],
          source: "OpenCLIApp bundled Node entrypoint",
        };
      }
      candidates.push(`${appMain} (missing)`);
    }
  }

  for (const packageDir of npmGlobalPackageDirs(deps)) {
    const resolved = resolvePackageBin(packageDir, deps, candidates);
    if (resolved) return resolved;
  }

  if (deps.platform === "linux" && deps.existsSync("/mnt/c/Users")) {
    const resolved = resolveWslWindowsOpenCli(deps, candidates);
    if (resolved) return resolved;
  }

  return null;
}

function npmGlobalPackageDirs(deps) {
  const dirs = [];
  const nodeDir = path.dirname(deps.execPath);
  dirs.push(path.join(nodeDir, "node_modules", ...OPENCLI_PACKAGE));

  if (deps.platform === "win32") {
    const appData = deps.env?.APPDATA;
    if (appData) dirs.push(path.join(appData, "npm", "node_modules", ...OPENCLI_PACKAGE));
  } else {
    dirs.push(path.join(path.dirname(nodeDir), "lib", "node_modules", ...OPENCLI_PACKAGE));
  }

  const pathValue = deps.env?.PATH ?? deps.env?.Path ?? "";
  for (const rawEntry of String(pathValue).split(path.delimiter)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    dirs.push(path.join(entry, "node_modules", ...OPENCLI_PACKAGE));
  }

  const seen = new Set();
  const unique = [];
  for (const dir of dirs) {
    const key = deps.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dir);
  }
  return unique;
}

function resolvePackageBin(packageDir, deps, candidates) {
  const manifestPath = path.join(packageDir, "package.json");
  if (!deps.existsSync(manifestPath)) {
    candidates.push(`${packageDir} (missing package.json)`);
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(deps.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    candidates.push(`${packageDir} (unreadable package.json: ${error.message})`);
    return null;
  }

  const relativeBin = pickBinEntry(manifest?.bin);
  if (!relativeBin) {
    candidates.push(`${packageDir} (package.json has no usable "bin" entry)`);
    return null;
  }

  const entry = path.resolve(packageDir, relativeBin);
  if (!deps.existsSync(entry)) {
    candidates.push(`${entry} (bin entry declared in package.json is missing)`);
    return null;
  }

  return {
    command: deps.execPath,
    prefixArgs: [entry],
    source: `npm global (${packageDir})`,
  };
}

function pickBinEntry(bin) {
  if (typeof bin === "string") return bin;
  if (bin && typeof bin === "object") {
    if (typeof bin.opencli === "string") return bin.opencli;
    const keys = Object.keys(bin);
    if (keys.length === 0) return null;
    const first = bin[keys[0]];
    return typeof first === "string" ? first : null;
  }
  return null;
}

function resolveWslWindowsOpenCli(deps, candidates) {
  const usersRoot = "/mnt/c/Users";
  if (!deps.existsSync(usersRoot)) return null;

  const preferred = [deps.env?.OPENCLI_MCP_WINDOWS_USER, deps.env?.USER].filter(Boolean);
  let discovered = [];
  try {
    discovered = deps.readdirSync(usersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    discovered = [];
  }
  const users = [...new Set([...preferred, ...discovered])];

  for (const user of users) {
    const mountedHome = path.join(usersRoot, user);
    const appMainMounted = path.join(
      mountedHome,
      "AppData",
      "Local",
      "OpenCLIApp",
      "node_modules",
      ...OPENCLI_PACKAGE,
      "dist",
      "src",
      "main.js",
    );
    if (!deps.existsSync(appMainMounted)) {
      candidates.push(`${appMainMounted} (missing)`);
      continue;
    }

    const versionsRoot = path.join(mountedHome, "AppData", "Roaming", "fnm", "node-versions");
    if (!deps.existsSync(versionsRoot)) {
      candidates.push(`${versionsRoot} (missing)`);
      continue;
    }

    let versions = [];
    try {
      versions = deps.readdirSync(versionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareVersionNames)
        .reverse();
    } catch {
      versions = [];
    }

    for (const version of versions) {
      const windowsNodeMounted = path.join(versionsRoot, version, "installation", "node.exe");
      if (!deps.existsSync(windowsNodeMounted)) continue;
      const appMainWindows = `C:\\Users\\${user}\\AppData\\Local\\OpenCLIApp\\node_modules\\@jackwener\\opencli\\dist\\src\\main.js`;
      return {
        command: windowsNodeMounted,
        prefixArgs: [appMainWindows],
        source: `WSL -> Windows Node (${version}) -> OpenCLIApp bundled entrypoint`,
      };
    }
  }
  return null;
}

function buildNotFoundMessage(candidates) {
  const lines = [
    "OpenCLI executable was not found.",
    "Install it globally with `npm i -g @jackwener/opencli` (opencli-mcp auto-discovers that layout),",
    "or set OPENCLI_MCP_BIN to the JavaScript entrypoint, optionally with OPENCLI_MCP_PREFIX_ARGS as a JSON string array,",
    `or add a ${CONFIG_FILE_NAME} file like { "bin": "node", "prefixArgs": ["<path to dist/src/main.js>"] }.`,
  ];
  if (candidates.length > 0) {
    lines.push("Probed candidates:");
    for (const candidate of candidates) lines.push(`  - ${candidate}`);
  }
  return lines.join("\n");
}

function compareVersionNames(left, right) {
  const a = left.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
  const b = right.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return left.localeCompare(right);
}

function parsePrefixArgs(raw) {
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`OPENCLI_MCP_PREFIX_ARGS must be a JSON string array: ${error.message}`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("OPENCLI_MCP_PREFIX_ARGS must be a JSON string array");
  }
  return value;
}

export function parseOpenCliOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Some commands return plain text; some versions may prefix informational lines.
  }

  const lines = text.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue looking for a JSON suffix.
    }
  }

  return text;
}

export class OpenCliError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "OpenCliError";
    this.details = details;
  }
}

function spawnHint(error) {
  const code = error?.code;
  if (code === "EFTYPE" || code === "EINVAL" || code === "ENOENT" || code === "EPERM") {
    return (
      ". The resolved command could not be executed directly; on Windows a .ps1/.cmd/.bat or " +
      "extensionless shim cannot be spawned with shell:false. Set OPENCLI_MCP_BIN to the package's " +
      ".js entrypoint (or OPENCLI_MCP_BIN=node plus OPENCLI_MCP_PREFIX_ARGS), or unset it to use auto-discovery."
    );
  }
  return "";
}

/**
 * Decide which OS the resolved CLI executable really runs on. Auto-discovery can
 * point WSL at a mounted Windows `node.exe`, where process.platform would report
 * "linux" even though the child is a Windows binary that writes Windows paths.
 */
function resolveExecutionPlatform(command, fallback = process.platform) {
  if (typeof command === "string" && WINDOWS_EXECUTABLE.test(command.trim())) return "win32";
  return fallback;
}

export function createOpenCliRunner(options = {}) {
  const resolved = options.resolved ?? resolveOpenCli(options.env ?? process.env, {
    cwd: options.cwd ?? process.cwd(),
  });
  const timeoutMs = options.timeoutMs ?? Number(process.env.OPENCLI_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const killDeadlineMs = options.killDeadlineMs ?? Math.max(DEFAULT_KILL_DEADLINE_MS, killGraceMs + 1_000);
  const isWindowsHost = process.platform === "win32";

  // Terminate the whole process tree, not just the direct child: OpenCLI can shell
  // out to yt-dlp and other workers that keep writing after the parent is gone.
  // Returns "stopped" (tree-wide signal accepted), "gone" (nothing left to stop)
  // or "failed", so an already-exited child is never confused with a stopped tree.
  const defaultKillTree = (child, signal) => {
    if (!child.pid) return "failed";
    if (isWindowsHost) {
      try {
        const result = spawnSync(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
            timeout: TASKKILL_TIMEOUT_MS,
            killSignal: "SIGKILL",
          },
        );
        // Only taskkill /T /F exiting 0 proves the Windows tree was terminated.
        return Boolean(result) && result.status === 0 ? "stopped" : "failed";
      } catch {
        return "failed";
      }
    }
    try {
      // POSIX children are spawned detached (own process group) so -pid targets the tree.
      process.kill(-child.pid, signal);
      return "stopped";
    } catch (error) {
      return error?.code === "ESRCH" ? "gone" : "failed";
    }
  };
  const killTree = options.killTree ?? defaultKillTree;

  // Windows environment keys are case-insensitive: spreading "Path" over "PATH"
  // would leave both in the child environment and let the OS pick unpredictably,
  // which can silently drop PATH. An override replaces any casing of its key.
  const mergeEnv = (base, override) => {
    if (!override) return base;
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (isWindowsHost) {
        const lower = key.toLowerCase();
        for (const existing of Object.keys(merged)) {
          if (existing !== key && existing.toLowerCase() === lower) delete merged[existing];
        }
      }
      merged[key] = value;
    }
    return merged;
  };

  const runOpenCli = async function runOpenCli(args, callOptions = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new TypeError("OpenCLI arguments must be a string array");
    }

    const finalArgs = [...resolved.prefixArgs, ...args];
    const effectiveTimeout = callOptions.timeoutMs ?? timeoutMs;

    return await new Promise((resolve, reject) => {
      const child = spawn(resolved.command, finalArgs, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // A per-call env is merged over the runner env, so a caller can retry on a
        // different browser session without rebuilding the runner for the whole
        // process and without having to restate PATH and friends.
        env: mergeEnv(options.env ?? process.env, callOptions.env),
        cwd: callOptions.cwd ?? options.cwd,
        detached: !isWindowsHost,
      });

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let termination = null;
      let treeStopAccepted = false;
      let timeoutTimer = null;
      const killTimers = new Set();

      const clearKillTimers = () => {
        for (const pending of killTimers) clearTimeout(pending);
        killTimers.clear();
      };

      const settle = (finish) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        clearKillTimers();
        finish();
      };

      const snapshot = () => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        return { stdout, stderr, data: parseOpenCliOutput(stdout) };
      };

      // Termination errors keep the partial capture so the caller can still
      // inventory whatever was written before the stop.
      const terminationError = (info = {}) => {
        const partial = snapshot();
        return new OpenCliError(termination.message, {
          ok: false,
          partial: true,
          code: termination.code,
          signal: info.signal ?? null,
          exit_code: info.code ?? null,
          termination_confirmed: info.confirmed === true,
          stdout: partial.stdout,
          stderr: partial.stderr,
          data: partial.data,
          invocation: {
            command: resolved.command,
            args: finalArgs,
            source: resolved.source,
          },
        });
      };

      const safeKill = (signal) => {
        try {
          child.kill(signal);
          return true;
        } catch {
          return false;
        }
      };

      const softStopTree = () => {
        if (isWindowsHost) return;
        // Windows has no graceful tree signal; POSIX gets SIGTERM to the group first.
        if (killTree(child, "SIGTERM") === "failed") safeKill("SIGTERM");
      };

      const forceStopTree = () => {
        if (settled) return;
        const outcome = killTree(child, "SIGKILL");
        if (outcome === "stopped" || outcome === "gone") {
          treeStopAccepted = true;
          return;
        }
        safeKill("SIGKILL");
      };

      // A direct-child close only proves the parent stopped. Force SIGKILL across
      // the whole group even when the parent exits early, then wait until the
      // group is empty (POSIX), so a SIGTERM-ignoring descendant that redirected
      // its stdio can never be mistaken for a confirmed stop.
      const confirmTreeStopped = () =>
        new Promise((resolve) => {
          if (settled) {
            resolve(false);
            return;
          }

          if (isWindowsHost) {
            // Reuse an already accepted taskkill /T /F stop: re-running it against
            // the now-dead pid reports "not found" (non-zero) and is no proof either way.
            resolve(treeStopAccepted || killTree(child, "SIGKILL") === "stopped");
            return;
          }

          const outcome = killTree(child, "SIGKILL");
          // "gone" means the whole group is already empty.
          if (outcome === "gone") return resolve(true);
          if (outcome !== "stopped") {
            resolve(false);
            return;
          }
          if (!child.pid) {
            resolve(false);
            return;
          }
          const deadline = Date.now() + TREE_PROBE_TIMEOUT_MS;
          const probe = () => {
            let gone = false;
            try {
              process.kill(-child.pid, 0);
            } catch (error) {
              if (error?.code !== "ESRCH") {
                resolve(false);
                return;
              }
              gone = true;
            }
            if (gone) {
              resolve(true);
              return;
            }
            if (settled || Date.now() >= deadline) {
              resolve(false);
              return;
            }
            killTimers.add(setTimeout(probe, TREE_PROBE_INTERVAL_MS));
          };
          probe();
        });

      const requestTermination = (code, message) => {
        if (settled || termination) return;
        termination = { code, message };
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }

        if (isWindowsHost) {
          forceStopTree();
        } else {
          softStopTree();
          killTimers.add(setTimeout(forceStopTree, killGraceMs));
        }
        // Absolute ceiling: if closure is never observed, report an unconfirmed
        // stop instead of hanging, so callers keep the directory and verify later.
        killTimers.add(
          setTimeout(() => {
            // Closure was never observed, so the stop stays unconfirmed even
            // after this last best-effort escalation.
            killTree(child, "SIGKILL");
            settle(() => reject(terminationError({ confirmed: false })));
          }, killDeadlineMs),
        );
      };

      timeoutTimer = setTimeout(() => {
        requestTermination("TIMEOUT", `OpenCLI timed out after ${effectiveTimeout}ms`);
      }, effectiveTimeout);

      const collect = (chunks, kind) => (chunk) => {
        if (settled || termination) return;
        const nextBytes = kind === "stdout" ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
        if (nextBytes > maxOutputBytes) {
          requestTermination("OUTPUT_LIMIT", `OpenCLI ${kind} exceeded ${maxOutputBytes} bytes`);
          return;
        }
        if (kind === "stdout") stdoutBytes = nextBytes;
        else stderrBytes = nextBytes;
        chunks.push(chunk);
      };

      child.stdout.on("data", collect(stdoutChunks, "stdout"));
      child.stderr.on("data", collect(stderrChunks, "stderr"));

      child.on("error", (error) => {
        if (settled) return;
        if (termination) {
          settle(() => reject(terminationError({ confirmed: treeStopAccepted })));
          return;
        }
        settle(() =>
          reject(
            new OpenCliError(`Failed to start OpenCLI (${resolved.command}): ${error.message}${spawnHint(error)}`, {
              command: resolved.command,
              args: finalArgs,
              code: "SPAWN_ERROR",
            }),
          ),
        );
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        if (termination) {
          // Only a confirmed whole-tree stop is safe for directory inventory and
          // cleanup; that confirmation is the completion signal callers await.
          confirmTreeStopped().then((confirmed) => {
            settle(() => reject(terminationError({ code, signal, confirmed })));
          });
          return;
        }

        const partial = snapshot();
        const result = {
          ok: code === 0,
          code,
          signal,
          stdout: partial.stdout,
          stderr: partial.stderr,
          data: partial.data,
          invocation: {
            command: resolved.command,
            args: finalArgs,
            source: resolved.source,
          },
        };

        if (code !== 0) {
          const structuredMessage =
            partial.data && typeof partial.data === "object" && partial.data.error
              ? partial.data.error.message || JSON.stringify(partial.data.error)
              : null;
          settle(() =>
            reject(
              new OpenCliError(
                structuredMessage || partial.stderr || `OpenCLI exited with code ${code}`,
                result,
              ),
            ),
          );
          return;
        }

        settle(() => resolve(result));
      });
    });
  };

  // Non-enumerable so it never leaks into JSON payloads, but callers such as the
  // XHS worker can reject a cross-OS (WSL -> Windows) executable up front.
  Object.defineProperty(runOpenCli, "executionPlatform", {
    value: options.executionPlatform ?? resolveExecutionPlatform(resolved.command),
    enumerable: false,
  });

  return runOpenCli;
}
