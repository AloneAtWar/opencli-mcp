import test from "node:test";
import assert from "node:assert/strict";
import {
  cutHead,
  cutTail,
  deepWellFormed,
  replaceLoneSurrogates,
  wellFormed,
} from "../src/text-safe.js";

// A lone surrogate is what a code-unit cut leaves behind: the emoji below is a
// surrogate pair, and slicing one code unit off it is exactly the bug that used
// to kill the tunnel session.
const LONE_HIGH = "\ud83d";
const LONE_LOW = "\udc4d";

test("wellFormed repairs lone surrogates and is an identity for clean text", () => {
  const clean = "小红书 default 1.8.8";
  assert.equal(wellFormed(clean), clean);
  assert.equal(wellFormed(""), "");

  const repaired = wellFormed(`L${LONE_HIGH}`);
  assert.equal(repaired.isWellFormed(), true);
  assert.equal(repaired, "L\uFFFD");

  // A valid pair is not touched, so emoji survive the repair pass.
  assert.equal(wellFormed("a👍b"), "a👍b");

  // Non-strings pass through untouched so callers can hand over anything.
  assert.equal(wellFormed(undefined), undefined);
  assert.equal(wellFormed(7), 7);
});

test("replaceLoneSurrogates matches the native toWellFormed result", () => {
  const samples = [
    "ok",
    LONE_HIGH,
    LONE_LOW,
    "👍",
    `a${LONE_HIGH}b${LONE_LOW}c`,
    `👍${LONE_HIGH}`,
    `${LONE_LOW}👍`,
  ];
  for (const sample of samples) {
    assert.equal(replaceLoneSurrogates(sample), sample.toWellFormed(), `sample ${JSON.stringify(sample)}`);
  }
});

test("cutHead never leaves a trailing high surrogate", () => {
  const text = "👍".repeat(8);
  for (let limit = 0; limit <= text.length + 1; limit += 1) {
    const cut = cutHead(text, limit);
    assert.equal(cut.isWellFormed(), true, `limit ${limit}`);
    assert.ok(cut.length <= limit, `limit ${limit} length`);
  }
  // The cut drops the half character instead of corrupting it.
  assert.equal(cutHead("x👍y", 2), "x");
  assert.equal(cutHead("x👍y", 3), "x👍");
  assert.equal(cutHead("x👍y", 4), "x👍y");
  assert.equal(cutHead("x👍y", 0), "");
  assert.equal(cutHead("x👍y", -5), "");
  assert.equal(cutHead("x👍y", Number.NaN), "");
  assert.equal(cutHead(undefined, 3), undefined);
});

test("cutTail never leaves a leading low surrogate", () => {
  const text = "👍".repeat(8);
  for (let limit = 0; limit <= text.length + 1; limit += 1) {
    const cut = cutTail(text, limit);
    assert.equal(cut.isWellFormed(), true, `limit ${limit}`);
    assert.ok(cut.length <= limit, `limit ${limit} length`);
  }
  assert.equal(cutTail("x👍y", 1), "y");
  // The last two code units are (low surrogate, "y"), and a low surrogate cannot
  // stand alone, so the cut drops it and keeps "y".
  assert.equal(cutTail("x👍y", 2), "y");
  assert.equal(cutTail("x👍y", 3), "👍y");
  assert.equal(cutTail("x👍y", 4), "x👍y");
  assert.equal(cutTail("x👍y", 0), "");
  assert.equal(cutTail("x👍y", Number.NaN), "");
  assert.equal(cutTail(undefined, 3), undefined);
});

// Regression guard on the documented precondition: these helpers only avoid
// *creating* a lone surrogate. Text that already contains one is passed through
// and it is the boundary sanitizer (deepWellFormed) that cleans it up.
test("cutHead does not repair a pre-existing lone surrogate", () => {
  const alreadyBroken = `x${LONE_HIGH}y`;
  assert.equal(cutHead(alreadyBroken, 4).isWellFormed(), false);
  assert.equal(deepWellFormed(alreadyBroken).isWellFormed(), true);
});

test("deepWellFormed walks values and keys, and keeps clean payloads by reference", () => {
  const dirty = {
    a: `L${LONE_HIGH}`,
    nested: { list: ["ok", `M${LONE_LOW}`] },
    [`k${LONE_HIGH}`]: 1,
  };
  const fixed = deepWellFormed(dirty);
  assert.equal(JSON.stringify(fixed).includes("\\ud8"), false);
  assert.deepEqual(Object.keys(fixed), ["a", "nested", "k\uFFFD"]);
  assert.equal(fixed.nested.list[1], "M\uFFFD");

  const clean = { a: "ok", list: [1, 2, { b: "中文" }] };
  assert.equal(deepWellFormed(clean), clean);
  assert.equal(deepWellFormed("plain"), "plain");
  assert.equal(deepWellFormed(null), null);
});

test("deepWellFormed passes non-plain values through by reference", () => {
  const buffer = Buffer.from("ab");
  const date = new Date(0);
  const map = new Map([["a", 1]]);
  const payload = { buffer, date, map, text: `x${LONE_HIGH}` };

  const fixed = deepWellFormed(payload);
  assert.equal(fixed.buffer, buffer);
  assert.equal(fixed.date, date);
  assert.equal(fixed.map, map);
  // The bug this guards against: a naive rebuild turns Buffer into {"0":97,...}
  // and Date/Map into {}.
  assert.deepEqual(Object.keys(fixed).sort(), ["buffer", "date", "map", "text"]);
  assert.equal(fixed.text, "x\uFFFD");
});

test("deepWellFormed keeps a JSON.parse __proto__ key as an own property", () => {
  const parsed = JSON.parse(`{"__proto__":{"x":1},"ok":${JSON.stringify(`v${LONE_HIGH}`)}}`);
  const fixed = deepWellFormed(parsed);
  assert.equal(Object.prototype.hasOwnProperty.call(fixed, "__proto__"), true);
  assert.deepEqual(Object.keys(fixed), ["__proto__", "ok"]);
  assert.equal(fixed.ok, "v\uFFFD");
});

test("deepWellFormed maps shared references to one sanitized copy", () => {
  const shared = { text: `a${LONE_HIGH}` };
  const payload = { x: shared, y: shared, list: [shared] };

  const fixed = deepWellFormed(payload);
  assert.equal(fixed.x, fixed.y);
  assert.equal(fixed.list[0], fixed.x);
  assert.equal(fixed.x.text, "a\uFFFD");
  assert.equal(JSON.stringify(fixed).includes("\\ud8"), false);
});

test("deepWellFormed repairs a cycle without recursing forever", () => {
  const cyclic = { text: `a${LONE_HIGH}` };
  cyclic.self = cyclic;
  const fixed = deepWellFormed(cyclic);
  assert.equal(fixed.text, "a\uFFFD");
  assert.equal(fixed.self, fixed);
});

test("deepWellFormed keeps a clean cyclic payload by reference", () => {
  const cyclic = { text: "ok" };
  cyclic.self = cyclic;
  assert.equal(deepWellFormed(cyclic), cyclic);
});

test("deepWellFormed keeps a null prototype when it has to rebuild", () => {
  const source = Object.create(null);
  source.bad = `x${LONE_HIGH}`;
  const fixed = deepWellFormed(source);
  assert.equal(Object.getPrototypeOf(fixed), null);
  assert.equal(fixed.bad, "x\uFFFD");
});
