// UTF-16 boundary helpers.
//
// JavaScript strings are sequences of UTF-16 code units, so `slice()` can cut a
// surrogate pair in half and leave a lone surrogate behind. A lone surrogate is
// still a valid JS string, and `JSON.stringify` happily emits it as a `\ud83d`
// escape, so nothing local complains - but a strict peer that validates decoded
// values (the tunnel control plane does) rejects the whole JSON payload with
// HTTP 400 and the MCP session dies with it.
//
// Two separate jobs live here:
//   * cutHead/cutTail  - do not *create* lone surrogates when truncating text.
//   * wellFormed/deepWellFormed - never *emit* a string that already has one,
//     wherever it came from (page text, CLI JSON, or a caller's arguments).

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Node >= 20 ships String.prototype.toWellFormed; the regex is the drop-in
// equivalent for older runtimes (and is exercised directly by the tests).
const HAS_TO_WELL_FORMED = typeof String.prototype.toWellFormed === "function";

/**
 * Replace unpaired surrogates with U+FFFD. Pure fallback for runtimes without
 * String.prototype.toWellFormed(); pairs are left untouched.
 */
export function replaceLoneSurrogates(value) {
  return typeof value === "string" ? value.replace(LONE_SURROGATE, "\uFFFD") : value;
}

/**
 * Return a well-formed copy of a string, or the input itself when it already is
 * one. Strings compare by value, so the `===` check is a cheap "did anything
 * change" test that costs one scan instead of two.
 */
export function wellFormed(value) {
  if (typeof value !== "string" || value === "") return value;
  const fixed = HAS_TO_WELL_FORMED ? value.toWellFormed() : replaceLoneSurrogates(value);
  return fixed === value ? value : fixed;
}

function normalizeLimit(limit) {
  return Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
}

/**
 * Keep at most `limit` code units from the front without splitting a surrogate
 * pair. A forward cut can only ever leave a trailing high surrogate, so one
 * trailing check is enough.
 *
 * Precondition: this only means "does not create" a lone surrogate. Text that
 * already contains one is returned as-is - that is what deepWellFormed is for.
 */
export function cutHead(value, limit) {
  if (typeof value !== "string") return value;
  const max = normalizeLimit(limit);
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Keep at most `limit` code units from the end without splitting a surrogate
 * pair. A backward cut can only ever leave a leading low surrogate.
 */
export function cutTail(value, limit) {
  if (typeof value !== "string") return value;
  const max = normalizeLimit(limit);
  if (max <= 0) return value.length === 0 ? value : "";
  if (value.length <= max) return value;
  let cut = value.slice(-max);
  const first = cut.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) cut = cut.slice(1);
  return cut;
}

// Only objects that JSON.parse can produce are rebuilt. Anything else (Date,
// Map, Set, Buffer, a class instance, a stream) is passed through by reference:
// rebuilding it would rewrite the response the host receives.
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isContainer(value) {
  return Array.isArray(value) || isPlainObject(value);
}

// First pass: does this payload actually need rebuilding? The common (clean)
// result stays allocation-free apart from the traversal itself.
function needsRepair(value, seen = new WeakSet()) {
  if (typeof value === "string") return wellFormed(value) !== value;
  if (!isContainer(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (needsRepair(item, seen)) return true;
    }
    return false;
  }

  for (const key of Object.keys(value)) {
    if (wellFormed(key) !== key) return true;
    if (needsRepair(value[key], seen)) return true;
  }
  return false;
}

// Second pass, only for payloads that need it. A container is registered in the
// cache before its children are visited, so the same object at two paths - and
// a cycle - both resolve to the same sanitized copy.
function repair(value, cache = new WeakMap()) {
  if (typeof value === "string") return wellFormed(value);
  if (!isContainer(value)) return value;

  const cached = cache.get(value);
  if (cached) return cached;

  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    cache.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      if (index in value) copy[index] = repair(value[index], cache);
    }
    return copy;
  }

  // Keep a null prototype when the source had one, and define every key rather
  // than assigning it so a JSON.parse "__proto__" key stays an own property.
  const copy = Object.create(Object.getPrototypeOf(value));
  cache.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, wellFormed(key), {
      value: repair(value[key], cache),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Recursively rewrite every string - values and keys - into well-formed form.
 *
 * The common (clean) payload is returned by reference: the first traversal only
 * reports whether anything needs repair, and the copy is built only when it
 * does. In the rebuilt graph, the same source object at two paths (or a cycle)
 * maps to one sanitized copy. Only enumerable, string-keyed properties are
 * copied, because that is what JSON can carry.
 */
export function deepWellFormed(value) {
  return needsRepair(value) ? repair(value) : value;
}
