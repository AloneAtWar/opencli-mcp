import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCollectExpression,
  buildFillSubmitExpression,
  buildWaitAnyExpression,
  executeCollect,
  executeFillSubmit,
  executeOpen,
  executeRead,
  executeWaitAny,
  isRefTarget,
  refTargetToSelector,
} from "../src/browser-advanced.js";

// --- open ---

test("executeOpen builds a browser-prefixed open command", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: { url: "https://example.com" } };
  };
  await executeOpen(run, { session: "open-test", url: "https://example.com", window: "background" });
  assert.deepEqual(args, ["browser", "open-test", "open", "https://example.com", "--window", "background"]);
});

test("executeOpen omits --window when not provided", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: { url: "https://example.com" } };
  };
  await executeOpen(run, { session: "open-test", url: "https://example.com" });
  assert.deepEqual(args, ["browser", "open-test", "open", "https://example.com"]);
});

// --- read ---

test("executeRead scopes html with --selector instead of a positional target", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: "<a>hi</a>" };
  };
  const result = await executeRead(run, { session: "read-test", selector: "a", property: "html" });
  assert.deepEqual(args, ["browser", "read-test", "get", "html", "--selector", "a"]);
  assert.equal(result.data.property, "html");
});

test("executeRead keeps a positional target for text", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: "Learn more" };
  };
  await executeRead(run, { session: "read-test", selector: "a", property: "text" });
  assert.deepEqual(args, ["browser", "read-test", "get", "text", "a"]);
});

test("executeRead accepts the target alias and forwards nth", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: { value: "second", matches_n: 6, match_level: "exact" } };
  };
  const result = await executeRead(run, { session: "read-test", target: 2, property: "text", nth: 1 });
  assert.deepEqual(args, ["browser", "read-test", "get", "text", "2", "--nth", "1"]);
  assert.equal(result.data.value, "second");
  assert.equal(result.data.nth, 1);
  assert.equal(result.data.matches_n, 6);
  assert.equal(result.data.ambiguous_selector, undefined);
});

test("executeRead maps an html numeric ref to a data-opencli-ref selector", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: "<a>hi</a>" };
  };
  const result = await executeRead(run, { session: "read-test", target: 1, property: "html" });
  assert.deepEqual(args, ["browser", "read-test", "get", "html", "--selector", '[data-opencli-ref="1"]']);
  assert.equal(result.data.property, "html");
  assert.equal(result.data.value, "<a>hi</a>");
  assert.equal(result.data.matches_n, undefined);
});

test("executeRead ignores nth for html and notes it", async () => {
  let args;
  const run = async (received) => {
    args = received;
    return { data: "<div>hi</div>" };
  };
  const result = await executeRead(run, { session: "read-test", selector: "#x", property: "html", nth: 2 });
  assert.deepEqual(args, ["browser", "read-test", "get", "html", "--selector", "#x"]);
  assert.equal(result.data.nth_ignored, true);
  assert.match(result.data.note, /nth/);
  assert.equal(result.data.matches_n, undefined);
});

test("executeRead flags ambiguity when a selector matches multiple elements", async () => {
  const run = async () => ({ data: { value: "First", matches_n: 6, match_level: "exact" } });
  const result = await executeRead(run, { session: "read-test", selector: "p", property: "text" });
  assert.equal(result.data.value, "First");
  assert.equal(result.data.ambiguous_selector, true);
  assert.equal(result.data.matches_n, 6);
  assert.match(result.data.hint, /nth/);
});

// --- ref helpers ---

test("isRefTarget and refTargetToSelector map refs to data-opencli-ref selectors", () => {
  assert.equal(isRefTarget(1), true);
  assert.equal(isRefTarget("2"), true);
  assert.equal(isRefTarget(" 3 "), true);
  assert.equal(isRefTarget("#id"), false);
  assert.equal(isRefTarget("a"), false);
  assert.equal(isRefTarget(undefined), false);
  assert.equal(isRefTarget(null), false);
  assert.equal(refTargetToSelector(1), '[data-opencli-ref="1"]');
  assert.equal(refTargetToSelector("42"), '[data-opencli-ref="42"]');
});

// --- fill_submit ---

test("fill_submit fallback verifies navigation around fill, focus, and key press", async () => {
  const calls = [];
  let url = "https://example.com/";
  const run = async (args) => {
    calls.push(args);
    if (args[2] === "get" && args[3] === "url") return { data: url };
    if (args[2] === "keys") url = "https://example.com/results";
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
    ["browser", "submit-test", "get", "url"],
    ["browser", "submit-test", "fill", "#search", "agent浏览器"],
    ["browser", "submit-test", "focus", "#search"],
    ["browser", "submit-test", "keys", "Enter"],
    ["browser", "submit-test", "get", "url"],
  ]);
  assert.equal(result.data.key, "Enter");
  assert.equal(result.data.mode, "cli-fallback");
  assert.equal(result.data.atomic_skipped, true);
  assert.equal(result.data.focus_ok, true);
  assert.equal(result.data.submit_verified, true);
  assert.equal(result.data.url_before, "https://example.com/");
  assert.equal(result.data.url_after, "https://example.com/results");
  assert.deepEqual(result.data.warnings, []);
});

test("fill_submit fallback skips url verification when verify_navigation is false", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { data: { focused: false } };
  };
  const result = await executeFillSubmit(run, {
    session: "submit-test",
    target: "#search",
    value: "x",
    atomic: false,
    verify_navigation: false,
  });
  assert.deepEqual(calls, [
    ["browser", "submit-test", "fill", "#search", "x"],
    ["browser", "submit-test", "focus", "#search"],
    ["browser", "submit-test", "keys", "Enter"],
  ]);
  assert.equal(result.data.mode, "cli-fallback");
  assert.equal(result.data.atomic_skipped, true);
  assert.equal(result.data.focus_ok, false);
  assert.equal(result.data.submit_verified, null);
  assert.deepEqual(result.data.warnings, ["focus_failed"]);
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

test("fill_submit uses the atomic DOM path for a numeric ref target", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { data: { ok: true, filled: true, focused: true, events_dispatched: true } };
  };
  const result = await executeFillSubmit(run, {
    session: "atomic-ref",
    target: 1,
    value: "OpenCLI",
    key: "Enter",
    timeout_ms: 5000,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["browser", "atomic-ref", "eval"]);
  assert.match(calls[0][3], /\[data-opencli-ref=\\"1\\"\]/);
  assert.equal(result.data.mode, "atomic-dom-event");
});

test("fill_submit falls back to the CLI path when a numeric ref is stale", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[2] === "eval") return { data: { ok: false, error: "target_not_found" } };
    return { data: { focused: true } };
  };
  const result = await executeFillSubmit(run, {
    session: "ref-stale",
    target: 1,
    value: "x",
    verify_navigation: false,
    timeout_ms: 5000,
  });
  assert.deepEqual(calls[0].slice(0, 3), ["browser", "ref-stale", "eval"]);
  assert.deepEqual(calls.slice(1), [
    ["browser", "ref-stale", "fill", "1", "x"],
    ["browser", "ref-stale", "focus", "1"],
    ["browser", "ref-stale", "keys", "Enter"],
  ]);
  assert.equal(result.data.mode, "cli-fallback");
  assert.equal(result.data.atomic_skipped, true);
  assert.equal(result.data.atomic_error, "target_not_found");
});

test("fill_submit event strategy skips form.submit", () => {
  const expr = buildFillSubmitExpression({ target: "#kw", value: "test", key: "Enter", submit_strategy: "event" });
  assert.match(expr, /submit_strategy/);
  assert.match(expr, /submitStrategy.*event/);
  assert.match(expr, /shouldSubmit.*form.*both/);
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

// --- in-page truncation ---

// These expressions run inside the page through `opencli browser <session> eval`,
// so a code-unit cut there leaves a lone surrogate in the eval result, which then
// travels back through the MCP response.
test("collect and discover expressions cut field text on code point boundaries", () => {
  const collect = buildCollectExpression({ selector: ".card", fields: [{ name: "text", property: "text" }] });
  const discover = buildCollectExpression({ discover: true });
  for (const expr of [collect, discover]) {
    assert.match(expr, /const cut=\(s,n\)=>/);
    assert.doesNotMatch(expr, /\.slice\(0,120\)/);
    assert.doesNotMatch(expr, /\.slice\(0,200\)/);
  }
  assert.doesNotMatch(collect, /value=value\.slice\(0,config\.maxFieldChars\)/);
  assert.match(collect, /value=cut\(value,config\.maxFieldChars\)/);
});

function evalInPage(expression, document) {
  // The expressions are self-contained IIFEs that only need `document`.
  return new Function("document", `return ${expression}`)(document);
}

test("collect leaves no half emoji when max_field_chars lands inside a pair", () => {
  const cardText = "👍👍👍";
  const card = {
    matches: () => false,
    querySelector: () => null,
    innerText: cardText,
    textContent: cardText,
    getAttribute: () => null,
  };
  const document = { querySelectorAll: (selector) => (selector === ".card" ? [card] : []) };
  const expression = buildCollectExpression({
    selector: ".card",
    fields: [{ name: "text", property: "text" }],
    required_fields: [],
    offset: 0,
    limit: 10,
    // Odd limit: 5 code units stop exactly between the two halves of the 3rd emoji.
    max_field_chars: 5,
  });

  const data = evalInPage(expression, document);
  assert.equal(data.count, 1);
  const text = data.items[0].text;
  assert.equal(text.isWellFormed(), true);
  assert.equal(text, "👍👍");
});

test("discover leaves no half emoji in probe samples", () => {
  const title = `${"x".repeat(119)}👍`;
  const preview = `${"y".repeat(199)}👍`;
  const heading = { innerText: title, textContent: title };
  const previewNode = { innerText: preview, textContent: preview };
  const item = {
    tagName: "LI",
    innerText: title,
    textContent: title,
    querySelector: (selector) => (selector === "h3" ? heading : selector === "span" ? previewNode : null),
  };
  const document = { querySelectorAll: (selector) => (selector === "li" ? [item, item] : []) };

  const data = evalInPage(buildCollectExpression({ discover: true }), document);
  assert.equal(data.candidates.length, 1);
  const sample = data.candidates[0].items[0];
  assert.equal(sample.title.isWellFormed(), true);
  assert.equal(sample.title, "x".repeat(119));
  assert.equal(sample.preview.isWellFormed(), true);
  assert.equal(sample.preview, "y".repeat(199));
});
