import { performance } from "node:perf_hooks";
import { executeCollect, executeFillSubmit, executeWaitAny, executeOpen, executeRead } from "./browser-advanced.js";
import {
  appendFlag,
  appendLocator,
  appendOption,
  appendTab,
  browserArgs,
  buildActionArgs,
  normalizeSession,
} from "./commands.js";

const DEFAULT_STEP_TIMEOUT_MS = 10_000;

// Semantic section markers for priority-based compaction
const SECTION_MARKERS = [
  { tag: "<nav", priority: 9, label: "nav" },
  { tag: "<header", priority: 8, label: "header" },
  { tag: "<footer", priority: 8, label: "footer" },
  { tag: "<aside", priority: 7, label: "aside" },
  { tag: "[role=navigation", priority: 9, label: "nav" },
  { tag: "[role=banner", priority: 8, label: "header" },
  { tag: "[role=contentinfo", priority: 8, label: "footer" },
];

function classifyLine(line) {
  const trimmed = line.trim();
  if (/^\[?\d+\]?<nav\b|<header\b|<footer\b|<aside\b/.test(trimmed)) return "low";
  if (/^\[?\d+\]?\s*<div\s/.test(trimmed) && /navigation|banner|contentinfo/i.test(trimmed)) return "low";
  if (/^[=\-]{3,}\s*$/.test(trimmed)) return "separator";
  if (/^\s*$/.test(trimmed)) return "blank";
  return "content";
}

export function compactSnapshotData(data, options = {}) {
  if (typeof data !== "string") {
    return { value: data, compacted: false, originalChars: 0, returnedChars: 0, omittedChars: 0 };
  }
  const maxChars = options.maxChars ?? 12_000;
  const maxLines = options.maxLines ?? 500;
  const omitDataTextareas = options.omitDataTextareas !== false;
  const priority = options.priority; // e.g. ["readme", "content"]

  const lines = data.split(/\r?\n/);
  const classified = [];
  let omittedLines = 0;

  for (const line of lines) {
    if (omitDataTextareas && /<textarea\b/i.test(line) && /(css|style|data|json|schema|state|config)/i.test(line)) {
      omittedLines += 1;
      continue;
    }
    if (classified.length >= maxLines) {
      omittedLines += 1;
      continue;
    }
    const kind = classifyLine(line);
    classified.push({ text: line.replace(/\s+$/g, ""), kind });
  }

  const totalChars = classified.reduce((s, l) => s + l.text.length + 1, 0);

  // If it fits, return everything
  if (totalChars <= maxChars && classified.length <= maxLines) {
    const value = classified.map((l) => l.text).join("\n").replace(/\n{4,}/g, "\n\n\n");
    return { value, compacted: omittedLines > 0, originalChars: data.length, returnedChars: value.length, omittedChars: data.length - value.length, omittedLines };
  }

  // Priority-based filling: keep all "content" lines, drop "low" lines first
  const markerReserve = 200;
  const budget = maxChars - markerReserve;

  // Split into content (high priority) and chrome (low priority)
  const contentLines = classified.filter((l) => l.kind === "content" || l.kind === "separator");
  const chromeLines = classified.filter((l) => l.kind === "low" || l.kind === "blank");

  const contentChars = contentLines.reduce((s, l) => s + l.text.length + 1, 0);

  if (contentChars <= budget) {
    // All content fits; fill remaining budget with chrome lines from both ends
    let remaining = budget - contentChars;
    const kept = [...contentLines];
    // Add chrome from tail (footer etc.) until budget
    for (let i = chromeLines.length - 1; i >= 0 && remaining > 0; i--) {
      const cost = chromeLines[i].text.length + 1;
      if (cost <= remaining) {
        kept.splice(kept.length, 0, chromeLines[i]);
        remaining -= cost;
      }
    }
    const value = kept.map((l) => l.text).join("\n").replace(/\n{4,}/g, "\n\n\n").slice(0, maxChars);
    const omittedChars = Math.max(0, data.length - value.length);
    const marker = omittedChars > 0 ? `\n---\n[compact snapshot: omitted ${omittedChars} char(s); content preserved, chrome trimmed]\n---\n` : "";
    const final = value.length > maxChars ? value.slice(0, maxChars) : value + marker;
    return {
      value: final.slice(0, maxChars),
      compacted: true,
      originalChars: data.length,
      returnedChars: Math.min(final.length, maxChars),
      omittedChars,
      omittedLines: classified.length - contentLines.length,
      content_lines: contentLines.length,
      chrome_lines: chromeLines.length,
    };
  }

  // Content exceeds budget: take first N content lines that fit
  let charsUsed = 0;
  const kept = [];
  for (const line of contentLines) {
    const cost = line.text.length + 1;
    if (charsUsed + cost > budget) break;
    kept.push(line);
    charsUsed += cost;
  }

  const value = kept.map((l) => l.text).join("\n").replace(/\n{4,}/g, "\n\n\n");
  const marker = `\n---\n[compact snapshot: kept ${kept.length}/${contentLines.length} content lines, ${chromeLines.length} chrome lines omitted; ${(data.length - value.length)} chars omitted]\n---\n`;
  const final = value.slice(0, Math.max(0, maxChars - marker.length)) + marker;

  return {
    value: final,
    compacted: true,
    originalChars: data.length,
    returnedChars: final.length,
    omittedChars: data.length - final.length,
    omittedLines: classified.length - kept.length,
    content_lines: kept.length,
    chrome_lines: chromeLines.length,
    note: "Content exceeds budget. Some content lines were truncated.",
  };
}

export function paginateNetworkData(data, options = {}) {
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) return data;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const total = data.entries.length;
  const entries = data.entries.slice(offset, offset + limit);
  return {
    ...data,
    entries,
    total_entries: total,
    returned: entries.length,
    offset,
    next_offset: offset + entries.length < total ? offset + entries.length : null,
  };
}

export function selectFindNth(data, nth) {
  if (nth === undefined || nth === null) return data;
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) return data;
  const selected = data.entries[nth];
  return {
    ...data,
    entries: selected ? [selected] : [],
    original_matches: data.entries.length,
    selected_nth: nth,
  };
}

export function normalizeWaitData(data, type, value) {
  if (type !== "time") return data;
  const waitedMs = Number(value);
  if (!Number.isFinite(waitedMs) || waitedMs < 0) return data;
  if (typeof data === "string" && /^Waited\s+\S+s$/i.test(data.trim())) {
    return `Waited ${waitedMs}ms`;
  }
  return data;
}

function buildSnapshotArgs(step, session) {
  const args = browserArgs(session, "state");
  if (step.source === "ax") args.push("--source", "ax");
  appendFlag(args, "--compare-sources", step.compare_sources);
  appendTab(args, step.tab);
  return args;
}

function buildWaitArgs(step, session) {
  const args = browserArgs(session, "wait", step.type);
  if (step.value !== undefined) args.push(String(step.value));
  appendOption(args, "--timeout", step.timeout_ms ?? step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
  appendTab(args, step.tab);
  return args;
}

function buildFindArgs(step, session) {
  const args = browserArgs(session, "find");
  appendOption(args, "--css", step.css);
  appendLocator(args, { ...step, nth: undefined });
  appendOption(args, "--limit", step.limit ?? 50);
  appendOption(args, "--text-max", step.text_max ?? 120);
  appendTab(args, step.tab);
  return args;
}

function buildGetArgs(step, session, target) {
  const args = browserArgs(session, "get", step.property);
  const positionalTarget = target ?? (step.property !== "html" ? step.selector : undefined);
  if (positionalTarget !== undefined && step.property !== "html") args.push(String(positionalTarget));
  if (step.property === "html") appendOption(args, "--selector", step.selector);
  appendOption(args, "--as", step.as);
  appendOption(args, "--depth", step.depth);
  appendOption(args, "--children-max", step.children_max);
  appendOption(args, "--text-max", step.text_max);
  appendLocator(args, step);
  appendTab(args, step.tab);
  return args;
}

function buildOpenArgs(step, session) {
  const args = browserArgs(session, "open", step.url);
  appendOption(args, "--window", step.window);
  appendTab(args, step.tab);
  return args;
}

function resolveTarget(target, variables) {
  if (typeof target !== "string" || !target.startsWith("$")) return target;
  const name = target.slice(1);
  if (!Object.hasOwn(variables, name)) throw new Error(`Unknown browser_flow variable: ${target}`);
  return variables[name];
}

function variableValue(data) {
  if (data && typeof data === "object") {
    if (Array.isArray(data.entries)) {
      if (data.entries.length !== 1 || data.entries[0]?.ref === undefined) {
        throw new Error(`save_as requires exactly one ref result; received ${data.entries.length}`);
      }
      return data.entries[0].ref;
    }
    if (data.ref !== undefined) return data.ref;
    if (data.value !== undefined && ["string", "number"].includes(typeof data.value)) return data.value;
  }
  if (["string", "number", "boolean"].includes(typeof data)) return data;
  if (data && typeof data === "object") return data;
  throw new Error("save_as could not derive a value from this step result");
}

function resultSummary(data) {
  if (typeof data === "string") return { type: "text", chars: data.length, preview: data.slice(0, 240) };
  if (Array.isArray(data)) return { type: "array", count: data.length };
  if (data && typeof data === "object") {
    return {
      type: "object",
      keys: Object.keys(data).slice(0, 20),
      matches: data.matches_n,
      entries: Array.isArray(data.entries) ? data.entries.length : undefined,
      items: Array.isArray(data.items) ? data.items.length : undefined,
      url: data.url,
      title: data.title,
    };
  }
  return { type: typeof data, value: data };
}

async function captureFailureState(run, session, captureInput) {
  if (captureInput === false) return null;
  const config = captureInput && typeof captureInput === "object" ? captureInput : {};
  const timeoutMs = config.timeout_ms ?? 5_000;
  const tasks = {};
  if (config.url !== false) tasks.url = run(browserArgs(session, "get", "url"), { timeoutMs });
  if (config.title !== false) tasks.title = run(browserArgs(session, "get", "title"), { timeoutMs });
  if (config.snapshot !== false) tasks.snapshot = run(buildSnapshotArgs({ source: config.source ?? "dom" }, session), { timeoutMs });
  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const capture = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const result = settled[index];
    if (result.status === "fulfilled") {
      if (name === "snapshot") {
        const compact = compactSnapshotData(result.value.data, {
          maxChars: config.max_chars ?? 6_000,
          maxLines: config.max_lines ?? 300,
          omitDataTextareas: config.omit_data_textareas,
        });
        capture.snapshot = compact.value;
        capture.snapshot_meta = { ...compact };
        delete capture.snapshot_meta.value;
      } else {
        capture[name] = result.value.data;
      }
    } else {
      capture[`${name}_error`] = result.reason?.message || String(result.reason);
    }
  }
  return capture;
}

async function executeStep(run, step, session, variables, timeoutMs) {
  const target = resolveTarget(step.target, variables);
  if (step.operation === "fill_submit") {
    return await executeFillSubmit(run, { ...step, session, target }, { timeoutMs });
  }
  if (step.operation === "wait_any") {
    return await executeWaitAny(run, { ...step, session }, { timeoutMs });
  }
  if (step.operation === "collect") {
    return await executeCollect(run, { ...step, session }, { timeoutMs });
  }
  if (step.operation === "open") {
    if (!step.url) throw new Error("browser_flow open requires url");
    return await executeOpen(run, { ...step, session }, { timeoutMs });
  }
  if (step.operation === "get") {
    if (!step.property) throw new Error("browser_flow get requires property");
    return await executeRead(run, { ...step, session, target }, { timeoutMs });
  }
  let args;
  let compactOptions;
  switch (step.operation) {
    case "find":
      args = buildFindArgs(step, session);
      break;
    case "action":
      if (!step.action) throw new Error("browser_flow action requires action");
      args = buildActionArgs({ ...step, session, target });
      break;
    case "wait":
      if (!step.type) throw new Error("browser_flow wait requires type");
      args = buildWaitArgs(step, session);
      break;
    case "snapshot":
      args = buildSnapshotArgs(step, session);
      compactOptions = step.compact === false ? null : {
        maxChars: step.max_chars ?? 12_000,
        maxLines: step.max_lines ?? 500,
        omitDataTextareas: step.omit_data_textareas,
      };
      break;
    case "back":
      args = browserArgs(session, "back");
      appendTab(args, step.tab);
      break;
    default:
      throw new Error(`Unsupported browser_flow operation: ${step.operation}`);
  }
  const result = await run(args, { timeoutMs });
  if (step.operation === "find") {
    result.data = selectFindNth(result.data, step.nth);
  }
  if (step.operation === "wait") {
    result.data = normalizeWaitData(result.data, step.type, step.value);
  }
  if (compactOptions) {
    const compacted = compactSnapshotData(result.data, compactOptions);
    return { ...result, data: compacted.value, compact: compacted };
  }
  return result;
}

export async function executeBrowserFlow(run, input) {
  const session = normalizeSession(input.session);
  const steps = input.steps ?? [];
  const maxSteps = input.max_steps ?? 8;
  if (steps.length === 0) throw new Error("browser_flow requires at least one step");
  if (steps.length > maxSteps) throw new Error(`browser_flow received ${steps.length} steps, above max_steps=${maxSteps}`);

  const totalMs = input.max_total_ms ?? 30_000;
  const started = Date.now();
  const startedMonotonic = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedMonotonic));
  const deadline = started + totalMs;
  const trace = [];
  const variables = {};
  let last = null;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const id = step.id || `step_${index + 1}`;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const capture = await captureFailureState(run, session, input.on_error_capture);
      return { status: "timeout", session, completed_steps: index, failed_step: id, elapsed_ms: elapsed(), trace, variables, last, capture };
    }
    const configuredStepTimeout = step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
    const attempts = Math.min((step.retry ?? 0) + 1, 2);
    const stepStarted = performance.now();
    let error;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const attemptRemaining = deadline - Date.now();
        if (attemptRemaining <= 0) throw new Error(`browser_flow total timeout reached before ${id}`);
        const attemptTimeout = Math.min(configuredStepTimeout, attemptRemaining);
        const result = await executeStep(run, step, session, variables, attemptTimeout);
        last = result.data;
        if (step.save_as) variables[step.save_as] = variableValue(result.data);
        trace.push({ id, operation: step.operation, status: "success", attempt, elapsed_ms: Math.max(0, Math.round(performance.now() - stepStarted)), result: resultSummary(result.data) });
        error = null;
        break;
      } catch (caught) {
        error = caught;
        if (attempt < attempts && Date.now() < deadline) continue;
      }
    }

    if (error) {
      const failed = { id, operation: step.operation, status: step.optional ? "skipped" : "failed", elapsed_ms: Math.max(0, Math.round(performance.now() - stepStarted)), error: { name: error.name, message: error.message, last_state: error.lastState } };
      trace.push(failed);
      if (!step.optional) {
        const capture = await captureFailureState(run, session, input.on_error_capture);
        return { status: "stopped", session, completed_steps: index, failed_step: id, elapsed_ms: elapsed(), trace, variables, last, capture };
      }
    }
  }

  return { status: "completed", session, completed_steps: steps.length, elapsed_ms: elapsed(), trace, variables, last };
}

export function buildWaitArgsForAction(waitFor, session, tab) {
  return buildWaitArgs({ ...waitFor, tab: waitFor.tab ?? tab }, session);
}

export function buildSnapshotArgsForAction(snapshotAfter, session, tab) {
  return buildSnapshotArgs({ ...snapshotAfter, tab: snapshotAfter.tab ?? tab }, session);
}
