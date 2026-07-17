import test from "node:test";
import assert from "node:assert/strict";
import { browserArgs, buildActionArgs, normalizeSession } from "../src/commands.js";

test("normalizes safe session names", () => {
  assert.equal(normalizeSession("hermes-task_1"), "hermes-task_1");
  assert.throws(() => normalizeSession("bad session"), /session must match/);
});

test("builds browser base arguments", () => {
  assert.deepEqual(browserArgs("demo", "state"), ["browser", "demo", "state"]);
});

test("builds click with ref and tab without shell interpolation", () => {
  assert.deepEqual(
    buildActionArgs({ action: "click", session: "demo", target: 7, tab: "page-1" }),
    ["browser", "demo", "click", "7", "--tab", "page-1"],
  );
});

test("preserves arbitrary text as one argv item", () => {
  const value = '中文 "quoted" & whoami\nsecond line';
  assert.deepEqual(
    buildActionArgs({ action: "fill", session: "demo", target: "#message", value }),
    ["browser", "demo", "fill", "#message", value],
  );
});

test("builds semantic type locator", () => {
  assert.deepEqual(
    buildActionArgs({
      action: "type",
      session: "demo",
      value: "hello",
      role: "textbox",
      name: "Search",
    }),
    ["browser", "demo", "type", "hello", "--role", "textbox", "--name", "Search"],
  );
});

test("validates required action fields", () => {
  assert.throws(() => buildActionArgs({ action: "upload", session: "demo", files: [] }), /at least one/);
  assert.throws(() => buildActionArgs({ action: "drag", session: "demo", source: 1 }), /destination/);
  assert.throws(() => buildActionArgs({ action: "keys", session: "demo" }), /requires key/);
});
