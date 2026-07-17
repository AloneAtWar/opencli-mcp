import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenCliRunner, OpenCliError, parseOpenCliOutput } from "../src/opencli-runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "echo-argv.js");

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
