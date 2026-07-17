const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function normalizeSession(session) {
  const value = session || process.env.OPENCLI_MCP_SESSION || "hermes-default";
  if (!SAFE_NAME.test(value)) {
    throw new Error("session must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/");
  }
  return value;
}

export function browserArgs(session, ...parts) {
  return ["browser", normalizeSession(session), ...parts.map(String)];
}

export function appendOption(args, flag, value) {
  if (value !== undefined && value !== null && value !== "") {
    args.push(flag, String(value));
  }
  return args;
}

export function appendFlag(args, flag, enabled) {
  if (enabled) args.push(flag);
  return args;
}

export function appendLocator(args, input, prefix = "") {
  const mapping = [
    ["role", `${prefix}role`],
    ["name", `${prefix}name`],
    ["label", `${prefix}label`],
    ["text_locator", `${prefix}text`],
    ["testid", `${prefix}testid`],
  ];
  for (const [field, option] of mapping) {
    appendOption(args, `--${option}`, input[field]);
  }
  appendOption(args, `--${prefix}nth`, input.nth);
  return args;
}

export function appendTab(args, tab) {
  return appendOption(args, "--tab", tab);
}

export function buildActionArgs(input) {
  const session = normalizeSession(input.session);
  const action = input.action;
  let args;

  switch (action) {
    case "click":
    case "hover":
    case "focus":
    case "dblclick":
    case "check":
    case "uncheck": {
      args = browserArgs(session, action);
      if (input.target !== undefined) args.push(String(input.target));
      appendLocator(args, input);
      break;
    }
    case "type":
    case "fill": {
      if (typeof input.value !== "string") throw new Error(`${action} requires value`);
      args = browserArgs(session, action);
      if (input.target !== undefined) args.push(String(input.target));
      args.push(input.value);
      appendLocator(args, input);
      break;
    }
    case "select": {
      if (typeof input.value !== "string") throw new Error("select requires value");
      args = browserArgs(session, "select");
      if (input.target !== undefined) args.push(String(input.target));
      args.push(input.value);
      appendLocator(args, input);
      break;
    }
    case "keys": {
      if (!input.key) throw new Error("keys requires key");
      args = browserArgs(session, "keys", input.key);
      break;
    }
    case "scroll": {
      if (!input.direction) throw new Error("scroll requires direction");
      args = browserArgs(session, "scroll", input.direction);
      appendOption(args, "--amount", input.amount);
      break;
    }
    case "upload": {
      if (!Array.isArray(input.files) || input.files.length === 0) {
        throw new Error("upload requires at least one file");
      }
      args = browserArgs(session, "upload");
      if (input.target !== undefined) args.push(String(input.target));
      args.push(...input.files);
      appendLocator(args, input);
      break;
    }
    case "drag": {
      if (input.source === undefined || input.destination === undefined) {
        throw new Error("drag requires source and destination");
      }
      args = browserArgs(session, "drag", input.source, input.destination);
      appendOption(args, "--from-nth", input.from_nth);
      appendOption(args, "--to-nth", input.to_nth);
      appendOption(args, "--from-role", input.from_role);
      appendOption(args, "--from-name", input.from_name);
      appendOption(args, "--to-role", input.to_role);
      appendOption(args, "--to-name", input.to_name);
      break;
    }
    default:
      throw new Error(`unsupported browser action: ${action}`);
  }

  appendTab(args, input.tab);
  return args;
}

export function assertAdapterName(value, field) {
  if (!SAFE_NAME.test(value || "")) {
    throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash`);
  }
  return value;
}

export function validateStringArray(values, field = "args") {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return values;
}
