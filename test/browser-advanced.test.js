import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCollectExpression,
  buildFillSubmitExpression,
  buildWaitAnyExpression,
  executeCollect,
  executeFillSubmit,
  executeWaitAny,
} from "../src/browser-advanced.js";

test("fill_submit fallback runs fill, focus, and key press in one bounded call", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { data: { ok: true, command: args[2] } };
  };
  const result = await executeFillSubmit(run, {
    session: "submit-test",
    target: "#search",
    value: "agent浏览器",
    key: "Enter",
    atomic: false,
    timeout_ms: 5000,
  });
  assert.deepEqual(calls, [
    ["browser", "submit-test", "fill", "#search", "agent浏览器"],
    ["browser", "submit-test", "focus", "#search"],
    ["browser", "submit-test", "keys", "Enter"],
  ]);
  assert.equal(result.data.key, "Enter");
});

test("fill_submit uses one atomic DOM event command for CSS targets", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { data: { ok: true, filled: true, focused: true, events_dispatched: true } };
  };
  const result = await executeFillSubmit(run, {
    session: "atomic-submit",
    target: "#search",
    value: "agent浏览器",
    key: "Enter",
    timeout_ms: 5000,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["browser", "atomic-submit", "eval"]);
  assert.equal(result.data.mode, "atomic-dom-event");
  assert.match(buildFillSubmitExpression({ target: "#search", value: "agent浏览器" }), /KeyboardEvent/);
});

test("wait_any returns the first matched condition", async () => {
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    return {
      data: attempts === 1
        ? { matched: false, url: "https://example.com/loading", title: "Loading" }
        : { matched: true, index: 1, condition: { type: "title_contains", value: "Ready" }, url: "https://example.com", title: "Ready" },
    };
  };
  const result = await executeWaitAny(run, {
    session: "wait-any",
    conditions: [
      { type: "url_contains", value: "/done" },
      { type: "title_contains", value: "Ready" },
    ],
    timeout_ms: 2000,
    poll_ms: 0,
  });
  assert.equal(result.data.matched, true);
  assert.equal(result.data.index, 1);
  assert.equal(result.data.attempts, 2);
});

test("wait_any and collect expressions JSON-escape user values", () => {
  const waitExpression = buildWaitAnyExpression([{ type: "text", value: "a'\"</script>" }]);
  assert.match(waitExpression, /conditions=/);
  const collectExpression = buildCollectExpression({
    selector: "section",
    fields: [{ name: "title", selector: "a[href]", property: "text" }],
  });
  assert.match(collectExpression, /querySelectorAll/);
  assert.match(collectExpression, /requiredFields/);
});

test("collect returns structured items from one eval command", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: { selector: "section", count: 1, items: [{ title: "Hello", href: "https://example.com" }] } };
  };
  const result = await executeCollect(run, {
    session: "collect-test",
    selector: "section",
    fields: [
      { name: "title", selector: "a", property: "text" },
      { name: "href", selector: "a", property: "href" },
    ],
  });
  assert.deepEqual(args.slice(0, 3), ["browser", "collect-test", "eval"]);
  assert.equal(result.data.items[0].title, "Hello");
});
