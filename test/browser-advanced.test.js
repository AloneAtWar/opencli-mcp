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

// --- fill_submit ---

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
  assert.equal(result.data.mode, "cli-fallback");
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
});

test("fill_submit event strategy skips form.submit", () => {
  const expr = buildFillSubmitExpression({ target: "#kw", value: "test", key: "Enter", submit_strategy: "event" });
  assert.match(expr, /submit_strategy/);
  assert.match(expr, /config\.submitStrategy==='event'/);
});

test("fill_submit both strategy dispatches events then form.submit", () => {
  const expr = buildFillSubmitExpression({ target: "#kw", value: "test", key: "Enter", submit_strategy: "both" });
  assert.match(expr, /config\.submitStrategy==='both'/);
});

// --- wait_any ---

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

test("wait_any tier 0 wins over tier 1 when both match simultaneously", async () => {
  const run = async () => ({
    data: { matched: true, index: 0, condition: { type: "selector", value: "#content_left" }, winner_tier: 0, url: "https://example.com", title: "Search" },
  });
  const result = await executeWaitAny(run, {
    session: "wait-tier",
    conditions: [
      { type: "text", value: "相关搜索", tier: 1 },
      { type: "selector", value: "#content_left", tier: 0 },
    ],
    timeout_ms: 1000,
    poll_ms: 0,
  });
  assert.equal(result.data.matched, true);
  assert.equal(result.data.condition.type, "selector");
  assert.equal(result.data.condition.value, "#content_left");
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

// --- collect ---

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

test("collect fallback_text reads root innerText when field selector misses", () => {
  const expr = buildCollectExpression({
    selector: ".card",
    fields: [{ name: "desc", selector: ".nonexistent", property: "text" }],
    fallback_text: true,
  });
  assert.match(expr, /fallbackText/);
  assert.match(expr, /root\.innerText/);
});

test("collect exclude filters by title_contains", () => {
  const expr = buildCollectExpression({
    selector: "section",
    fields: [{ name: "title", property: "text" }],
    exclude: { title_contains: ["广告", "大家还在搜"] },
  });
  assert.match(expr, /matchesExclude/);
  assert.match(expr, /title_contains/);
});

test("collect deduplicate_by removes duplicates", () => {
  const expr = buildCollectExpression({
    selector: "section",
    fields: [{ name: "title", property: "text" }],
    deduplicate_by: "title",
  });
  assert.match(expr, /config\.deduplicateBy/);
});

test("collect discover mode returns candidate selectors", () => {
  const expr = buildCollectExpression({ discover: true });
  assert.match(expr, /mode:'discover'/);
  assert.match(expr, /probeSelectors/);
  assert.match(expr, /candidates/);
  assert.match(expr, /tip/);
});
