import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function resolveOpenCli(env = process.env) {
  if (env.OPENCLI_MCP_BIN) {
    return {
      command: env.OPENCLI_MCP_BIN,
      prefixArgs: parsePrefixArgs(env.OPENCLI_MCP_PREFIX_ARGS),
      source: "OPENCLI_MCP_BIN",
    };
  }

  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      // OpenCLIApp's public .cmd shim ultimately launches this JavaScript entrypoint.
      // Running it with the already-active Windows Node runtime avoids cmd.exe entirely,
      // so every MCP string remains one exact argv item (no shell metacharacter parsing).
      const appMain = path.join(
        localAppData,
        "OpenCLIApp",
        "node_modules",
        "@jackwener",
        "opencli",
        "dist",
        "src",
        "main.js",
      );
      if (existsSync(appMain)) {
        return {
          command: process.execPath,
          prefixArgs: [appMain],
          source: "OpenCLIApp bundled Node entrypoint",
        };
      }
    }
  }

  if (process.platform === "linux" && existsSync("/mnt/c/Users")) {
    const resolved = resolveWslWindowsOpenCli(env);
    if (resolved) return resolved;
  }

  throw new Error(
    "OpenCLI executable was not found. Set OPENCLI_MCP_BIN to a native executable " +
      "and optionally OPENCLI_MCP_PREFIX_ARGS to a JSON string array. OpenCLIApp is " +
      "auto-discovered on native Windows and WSL when a Windows fnm Node installation exists.",
  );
}

function resolveWslWindowsOpenCli(env) {
  const usersRoot = "/mnt/c/Users";
  if (!existsSync(usersRoot)) return null;

  const preferred = [env.OPENCLI_MCP_WINDOWS_USER, env.USER].filter(Boolean);
  const discovered = readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const users = [...new Set([...preferred, ...discovered])];

  for (const user of users) {
    const mountedHome = path.join(usersRoot, user);
    const appMainMounted = path.join(
      mountedHome,
      "AppData",
      "Local",
      "OpenCLIApp",
      "node_modules",
      "@jackwener",
      "opencli",
      "dist",
      "src",
      "main.js",
    );
    if (!existsSync(appMainMounted)) continue;

    const versionsRoot = path.join(mountedHome, "AppData", "Roaming", "fnm", "node-versions");
    if (!existsSync(versionsRoot)) continue;
    const versions = readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionNames)
      .reverse();

    for (const version of versions) {
      const windowsNodeMounted = path.join(versionsRoot, version, "installation", "node.exe");
      if (!existsSync(windowsNodeMounted)) continue;
      const appMainWindows = `C:\\Users\\${user}\\AppData\\Local\\OpenCLIApp\\node_modules\\@jackwener\\opencli\\dist\\src\\main.js`;
      return {
        command: windowsNodeMounted,
        prefixArgs: [appMainWindows],
        source: `WSL → Windows Node (${version}) → OpenCLIApp bundled entrypoint`,
      };
    }
  }
  return null;
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

export function createOpenCliRunner(options = {}) {
  const resolved = options.resolved ?? resolveOpenCli(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? Number(process.env.OPENCLI_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return async function runOpenCli(args, callOptions = {}) {
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
        env: options.env ?? process.env,
        cwd: callOptions.cwd,
      });

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill();
        settled = true;
        reject(
          new OpenCliError(`OpenCLI timed out after ${effectiveTimeout}ms`, {
            command: resolved.command,
            args: finalArgs,
            code: "TIMEOUT",
          }),
        );
      }, effectiveTimeout);

      const collect = (chunks, kind) => (chunk) => {
        const nextBytes = kind === "stdout" ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
        if (nextBytes > maxOutputBytes) {
          child.kill();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(
              new OpenCliError(`OpenCLI ${kind} exceeded ${maxOutputBytes} bytes`, {
                command: resolved.command,
                args: finalArgs,
                code: "OUTPUT_LIMIT",
              }),
            );
          }
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
        settled = true;
        clearTimeout(timer);
        reject(
          new OpenCliError(`Failed to start OpenCLI: ${error.message}`, {
            command: resolved.command,
            args: finalArgs,
            code: "SPAWN_ERROR",
          }),
        );
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const parsed = parseOpenCliOutput(stdout);
        const result = {
          ok: code === 0,
          code,
          signal,
          stdout,
          stderr,
          data: parsed,
          invocation: {
            command: resolved.command,
            args: finalArgs,
            source: resolved.source,
          },
        };

        if (code !== 0) {
          const structuredMessage =
            parsed && typeof parsed === "object" && parsed.error
              ? parsed.error.message || JSON.stringify(parsed.error)
              : null;
          reject(
            new OpenCliError(
              structuredMessage || stderr || `OpenCLI exited with code ${code}`,
              result,
            ),
          );
          return;
        }

        resolve(result);
      });
    });
  };
}
