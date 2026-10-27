// Module-level tests for src/cli-failure.js, the shared description of a CLI
// failure used by every tool (errorResult) and by the Xiaohongshu media
// subcommands. The interesting cases are the boundaries: long diagnostics must
// keep their actionable end, hints must obey the same redaction and size rules as
// messages, and credentials must never survive while paths do.

import test from "node:test";
import assert from "node:assert/strict";
import { boundedTail, isNavigationRejected, redactSecrets, summarizeCliResult, summarizeFailure } from "../src/cli-failure.js";
import { OpenCliError } from "../src/opencli-runner.js";

test("a long stderr dump keeps its final actionable line", () => {
  const noise = "download progress ".repeat(120);
  const error = new OpenCliError("OpenCLI exited with code 1", {
    code: 1,
    stdout: "",
    stderr: `${noise}\nSECURITY_BLOCK: login again`,
    data: {},
  });

  const summary = summarizeFailure(error);

  assert.match(summary.message, /SECURITY_BLOCK: login again$/);
  assert.ok(summary.message.length <= 603, "the message stays bounded");
  assert.equal(summary.cli_error_code, "1", "the runner code is preserved when the CLI emitted no structured code");
  assert.equal(summary.exit_code, 1);
});

test("a structured CLI message wins over a bare exit-code sentence", () => {
  const error = new OpenCliError("OpenCLI exited with code 2", {
    code: 2,
    stdout: "",
    stderr: "noise",
    data: { error: { code: "EMPTY_RESULT", message: "No downloadable media found on this note." } },
  });

  const summary = summarizeFailure(error);

  assert.equal(summary.message, "No downloadable media found on this note.");
  assert.equal(summary.cli_error_code, "EMPTY_RESULT");
  assert.equal(summary.exit_code, 2);
  assert.equal(summary.stderr_tail, "noise");
});

test("hints are flattened, bounded, and redacted like messages", () => {
  const stringHint = summarizeFailure(new OpenCliError("failed", {
    code: "E1",
    stderr: "",
    data: { error: { code: "CLI_X", message: "failed", hint: `see https://example.test/?access_token=SECRET ${"y".repeat(400)}` } },
  }));
  assert.equal(typeof stringHint.hint, "string");
  assert.ok(!stringHint.hint.includes("SECRET"), "the query secret is redacted");
  assert.ok(stringHint.hint.length <= 303, "the hint is bounded");

  const objectHint = summarizeFailure(new OpenCliError("failed", {
    code: "E1",
    stderr: "",
    data: { error: { code: "CLI_X", message: "failed", hint: { url: "https://example.test/?token=T" } } },
  }));
  assert.equal(typeof objectHint.hint, "string", "an object hint is flattened instead of forwarded");
  assert.ok(!objectHint.hint.includes("token=T"));
});

test("server-local paths survive redaction while credentials do not", () => {
  const windowsPath = "C:\\Users\\dev\\AppData\\Local\\opencli-xhs\\opencli-xhs-images\\opencli-xhs-1\\abc123\\abc123_2.jpg";
  const summary = summarizeFailure(new OpenCliError("write failed", {
    code: 1,
    stdout: "",
    stderr: `cannot write ${windowsPath} (xsec_token=SECRET)`,
    data: {},
  }), { secrets: ["SECRET"] });

  const combined = `${summary.message} ${summary.stderr_tail ?? ""}`;
  assert.ok(combined.includes(windowsPath), "a local path is diagnosis, not a secret");
  assert.ok(!combined.includes("SECRET"), "the credential is redacted wherever it appears");
  assert.equal(redactSecrets("https://e.test/?xsec_token=ABC&x=1"), "https://e.test/?xsec_token=[redacted]&x=1");
});

test("boundedTail keeps the end and boundedText keeps the start", () => {
  assert.equal(boundedTail("0123456789", { limit: 4 }), "...6789");
});

test("summarizeCliResult reads both the flat media shape and a runner-shaped result", () => {
  const flat = summarizeCliResult({ ok: false, code: 4, stderr: "boom", error: { code: 4, message: "CLI said boom" } });
  assert.equal(flat.cli_error_code, "4");
  assert.equal(flat.exit_code, 4);
  assert.equal(flat.message, "CLI said boom");

  const structured = summarizeCliResult({ ok: false, code: 4, stderr: "boom", data: { error: { code: "PARTIAL_MEDIA", message: "two media items failed" } } });
  assert.equal(structured.cli_error_code, "PARTIAL_MEDIA");
  assert.equal(structured.exit_code, 4);
  assert.equal(structured.message, "two media items failed");
});

test("a Navigation rejected failure carries an actionable hint", () => {
  const error = new OpenCliError("Navigation rejected.", { code: 1, stdout: "", stderr: "Navigation rejected." });

  const summary = summarizeFailure(error);

  assert.equal(summary.message, "Navigation rejected.");
  assert.equal(summary.exit_code, 1);
  assert.match(summary.hint, /tab navigation/i);
  assert.match(summary.hint, /retry/i);
});

test("a hint from the CLI wins over the Navigation rejected hint", () => {
  const error = new OpenCliError("OpenCLI exited with code 2", {
    code: 2,
    stdout: "",
    stderr: "Navigation rejected.",
    data: { error: { code: "XHS_NAV", message: "Navigation rejected.", hint: "close the automation window first" } },
  });

  const summary = summarizeFailure(error);

  assert.equal(summary.hint, "close the automation window first");
});

test("isNavigationRejected reads a thrown error or a raw string", () => {
  assert.equal(isNavigationRejected(new OpenCliError("boom", { stderr: "Navigation rejected." })), true);
  assert.equal(isNavigationRejected("opencli: Navigation rejected."), true);
  assert.equal(isNavigationRejected(new Error("exited with code 1")), false);
});
