import test from "node:test";
import assert from "node:assert/strict";
import {
  compactSnapshotData,
  executeBrowserFlow,
  normalizeWaitData,
  paginateNetworkData,
  selectFindNth,
} from "../src/browser-flow.js";

test("compacts noisy snapshots with explicit omission metadata", () => {
  const raw = [
    "URL: https://example.com",
    "[1]<textarea id=page_css value=<style>large</style></textarea>",
    "[2]<button>Continue</button>",
    "line four",
    "line five",
  ].join("\n");
  const result = compactSnapshotData(raw, { maxChars: 2000, maxLines: 3 });
  assert.equal(result.compacted, true);
  assert.doesNotMatch(result.value, /page_css/);
  assert.match(result.value, /Continue/);
  assert.match(result.value, /compact snapshot/);
});

test("preserves both head and tail when compacting a long snapshot", () => {
  const raw = `URL: https://example.com\n${"middle-noise\n".repeat(200)}[99]<button>TARGET_AT_END</button>`;
  const result = compactSnapshotData(raw, { maxChars: 800, maxLines: 500 });
  assert.equal(result.compacted, true);
  assert.ok(result.value.length <= 800);
  assert.match(result.value, /URL: https:\/\/example.com/);
  assert.match(result.value, /TARGET_AT_END/);
  assert.match(result.value, /head and tail preserved/);
});

test("selects nth find result in the MCP layer", () => {
  const selected = selectFindNth({ entries: [{ ref: 3 }, { ref: 7 }] }, 1);
  assert.deepEqual(selected.entries, [{ ref: 7 }]);
  assert.equal(selected.original_matches, 2);
  assert.equal(selected.selected_nth, 1);
});

test("normalizes OpenCLI time-wait output to milliseconds", () => {
  assert.equal(normalizeWaitData("Waited 1500s", "time", "1500"), "Waited 1500ms");
  assert.equal(normalizeWaitData("Text appeared", "text", "hello"), "Text appeared");
});

test("paginates network entries and returns a cursor", () => {
  const data = { count: 5, entries: [1, 2, 3, 4, 5] };
  assert.deepEqual(paginateNetworkData(data, { offset: 1, limit: 2 }), {
    count: 5,
    entries: [2, 3],
    total_entries: 5,
    returned: 2,
    offset: 1,
    next_offset: 3,
  });
});

test("executes a bounded flow and resolves saved refs", async () => {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args.includes("find")) return { data: { entries: [{ ref: 7, text: "Continue" }] } };
    if (args.includes("click")) return { data: { clicked: true, target: "7" } };
    if (args.includes("state")) return { data: "URL: https://example.com\n[1]<textarea id=data_json>noise</textarea>\n<h1>Done</h1>" };
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
  const result = await executeBrowserFlow(run, {
    session: "flow-test",
    max_steps: 3,
    max_total_ms: 5000,
    steps: [
      { id: "find", operation: "find", role: "button", name: "Continue", save_as: "button" },
      { id: "click", operation: "action", action: "click", target: "$button" },
      { id: "state", operation: "snapshot", max_chars: 2000 },
    ],
  });
  assert.equal(result.status, "completed");
  assert.equal(result.variables.button, 7);
  assert.deepEqual(calls[1].args, ["browser", "flow-test", "click", "7"]);
  assert.doesNotMatch(result.last, /data_json/);
  assert.match(result.last, /Done/);
});

test("maps get text selector to the positional target required by OpenCLI", async () => {
  let received;
  const run = async (args) => {
    received = args;
    return { data: "detail body" };
  };
  const result = await executeBrowserFlow(run, {
    session: "get-selector",
    steps: [{ operation: "get", property: "text", selector: "#detail-desc", save_as: "body" }],
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(received, ["browser", "get-selector", "get", "text", "#detail-desc"]);
  assert.equal(result.variables.body, "detail body");
});

test("stops with a partial trace on a required failure", async () => {
  const run = async (args) => {
    if (args.includes("open")) return { data: { url: "https://example.com" } };
    throw new Error("not found");
  };
  const result = await executeBrowserFlow(run, {
    session: "flow-stop",
    max_steps: 2,
    max_total_ms: 5000,
    steps: [
      { operation: "open", url: "https://example.com" },
      { id: "missing", operation: "action", action: "click", role: "button", name: "Missing" },
    ],
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.completed_steps, 1);
  assert.equal(result.failed_step, "missing");
  assert.equal(result.trace.at(-1).status, "failed");
});

test("captures URL, title, and compact snapshot after required failure", async () => {
  const run = async (args) => {
    if (args[2] === "click") throw new Error("click failed");
    if (args.join(" ").includes("get url")) return { data: "https://example.com/failure" };
    if (args.join(" ").includes("get title")) return { data: "Failure Page" };
    if (args[2] === "state") return { data: "URL: https://example.com/failure\n<h1>Failure Page</h1>" };
    throw new Error(`unexpected capture args: ${args.join(" ")}`);
  };
  const result = await executeBrowserFlow(run, {
    session: "capture-failure",
    steps: [{ id: "bad-click", operation: "action", action: "click", target: 1 }],
    on_error_capture: { max_chars: 2000 },
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.capture.url, "https://example.com/failure");
  assert.equal(result.capture.title, "Failure Page");
  assert.match(result.capture.snapshot, /Failure Page/);
});

test("skips optional failures without looping", async () => {
  let calls = 0;
  const run = async (args) => {
    calls += 1;
    if (args.includes("click")) throw new Error("optional missing");
    return { data: "Example Domain" };
  };
  const result = await executeBrowserFlow(run, {
    session: "flow-optional",
    max_steps: 2,
    max_total_ms: 5000,
    steps: [
      { operation: "action", action: "click", role: "button", name: "Dismiss", optional: true, retry: 1 },
      { operation: "get", property: "title" },
    ],
  });
  assert.equal(result.status, "completed");
  assert.equal(result.trace[0].status, "skipped");
  assert.equal(calls, 3);
});
