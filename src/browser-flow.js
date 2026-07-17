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

export function compactSnapshotData(data, options = {}) {
  if (typeof data !== "string") {
    return { value: data, compacted: false, originalChars: 0, returnedChars: 0, omittedChars: 0 };
  }
  const maxChars = options.maxChars ?? 12_000;
  const maxLines = options.maxLines ?? 500;
  const omitDataTextareas = options.omitDataTextareas !== false;
  const lines = data.split(/\r?\n/);
  const kept = [];
  let omittedLines = 0;

  for (const line of lines) {
    if (
      omitDataTextareas &&
      /<textarea\b/i.test(line) &&
      /(css|style|data|json|schema|state|config)/i.test(line)
    ) {
      omittedLines += 1;
      continue;
    }
    if (kept.length >= maxLines) {
      omittedLines += 1;
      continue;
    }
    kept.push(line.replace(/\s+$/g, ""));
  }

  let value = kept.join("\n").replace(/\n{4,}/g, "\n\n\n");
  let truncated = false;
  let middleOmittedChars = 0;
  if (value.length > maxChars) {
    truncated = true;
    const markerReserve = 180;
    const payloadBudget = Math.max(1, maxChars - markerReserve);
    const headBudget = Math.floor(payloadBudget * 0.35);
    const tailBudget = payloadBudget - headBudget;
    let head = value.slice(0, headBudget).replace(/\n[^\n]*$/, "");
    let tail = value.slice(-tailBudget).replace(/^[^\n]*\n/, "");
    middleOmittedChars = Math.max(0, value.length - head.length - tail.length);
    const marker = `\n---\n[compact snapshot: omitted ${middleOmittedChars} middle char(s); head and tail preserved]\n---\n`;
    value = `${head}${marker}${tail}`;
    if (value.length > maxChars) value = value.slice(0, maxChars);
  }
  const omittedChars = Math.max(0, data.length - value.length);
  if (omittedLines > 0 && !truncated) {
    const marker = `\n---\n[compact snapshot: omitted ${omittedLines} line(s), ${omittedChars} char(s); request a larger limit or full browser_snapshot if needed]`;
    value = `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
  }
  return {
    value,
    compacted: omittedLines > 0 || truncated,
    originalChars: data.length,
    returnedChars: value.length,
    omittedChars,
    omittedLines,
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
  if (target !== undefined && step.property !== "html") args.push(String(target));
  appendOption(args, "--selector", step.selector);
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
  if (["string", "number"].includes(typeof data)) return data;
  throw new Error("save_as could not derive a scalar/ref value from this step result");
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
      url: data.url,
      title: data.title,
    };
  }
  return { type: typeof data, value: data };
}

async function executeStep(run, step, session, variables, timeoutMs) {
  const target = resolveTarget(step.target, variables);
  let args;
  let compactOptions;
  switch (step.operation) {
    case "open":
      if (!step.url) throw new Error("browser_flow open requires url");
      args = buildOpenArgs(step, session);
      break;
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
    case "get":
      if (!step.property) throw new Error("browser_flow get requires property");
      args = buildGetArgs(step, session, target);
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
  const deadline = started + totalMs;
  const trace = [];
  const variables = {};
  let last = null;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const id = step.id || `step_${index + 1}`;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { status: "timeout", session, completed_steps: index, failed_step: id, elapsed_ms: Date.now() - started, trace, variables, last };
    }
    const configuredStepTimeout = step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
    const attempts = Math.min((step.retry ?? 0) + 1, 2);
    const stepStarted = Date.now();
    let error;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const attemptRemaining = deadline - Date.now();
        if (attemptRemaining <= 0) throw new Error(`browser_flow total timeout reached before ${id}`);
        const attemptTimeout = Math.min(configuredStepTimeout, attemptRemaining);
        const result = await executeStep(run, step, session, variables, attemptTimeout);
        last = result.data;
        if (step.save_as) variables[step.save_as] = variableValue(result.data);
        trace.push({ id, operation: step.operation, status: "success", attempt, elapsed_ms: Date.now() - stepStarted, result: resultSummary(result.data) });
        error = null;
        break;
      } catch (caught) {
        error = caught;
        if (attempt < attempts && Date.now() < deadline) continue;
      }
    }

    if (error) {
      const failed = { id, operation: step.operation, status: step.optional ? "skipped" : "failed", elapsed_ms: Date.now() - stepStarted, error: { name: error.name, message: error.message } };
      trace.push(failed);
      if (!step.optional) {
        return { status: "stopped", session, completed_steps: index, failed_step: id, elapsed_ms: Date.now() - started, trace, variables, last };
      }
    }
  }

  return { status: "completed", session, completed_steps: steps.length, elapsed_ms: Date.now() - started, trace, variables, last };
}

export function buildWaitArgsForAction(waitFor, session, tab) {
  return buildWaitArgs({ ...waitFor, tab: waitFor.tab ?? tab }, session);
}

export function buildSnapshotArgsForAction(snapshotAfter, session, tab) {
  return buildSnapshotArgs({ ...snapshotAfter, tab: snapshotAfter.tab ?? tab }, session);
}
