// Shared description of an OpenCLI CLI failure.
//
// A CLI failure reaches the MCP layer in two shapes: a thrown OpenCliError (the
// tool answers with an MCP error through errorResult) or a returned result with
// ok:false that still carries usable output (a partial media download). Both
// shapes are normalized here so every tool reports the same fields: the CLI's own
// reason, its semantic code, the process exit code when there is one, and any
// hint - all with credentials removed and the text bounded.

import { cutHead, cutTail } from "./text-safe.js";

const SECRET_QUERY = /([?&](?:xsec_token|xsec_source|token|access_token|auth|key)=)[^&\s"']+/gi;

// Chrome's Tabs API refuses a tab navigation with this text when the automation
// tab was closed or replaced between lease resolution and tabs.update. OpenCLI
// only recognises it inside the Google Images adapter, so everywhere else it
// arrives as a bare message with no error code; a hint is what turns it into
// something an agent can act on.
const NAVIGATION_REJECTED = /navigation rejected/i;

// The match is deliberately loose: this text is only used to attach prose and to
// decide a single replay, and Chrome emits the sentence verbatim. A stricter
// per-line match would miss the shapes the CLI actually forwards (a YAML block,
// or stderr joined into one line), which would silently disable the retry.
const NAVIGATION_REJECTED_HINT =
  'This looks like Chrome refusing a tab navigation (a browser tab race, not platform risk control or a login problem). ' +
  'Retrying usually succeeds; if it keeps failing, close the automation window so the next call opens a fresh tab.';

// Accepts a thrown error (with the runner's details.stderr) or a plain string,
// so the same test serves the failure summary and the media retry decision.
export function isNavigationRejected(source) {
  const text = typeof source === 'string'
    ? source
    : `${source?.message ?? ''} ${source?.details?.stderr ?? ''}`;
  return NAVIGATION_REJECTED.test(text);
}

export function redactSecrets(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(SECRET_QUERY, '$1[redacted]');
}

export function urlSecrets(url) {
  try {
    const token = new URL(url).searchParams.get('xsec_token');
    return token ? [token] : [];
  } catch {
    return [];
  }
}

function normalize(value, secrets) {
  return redactSecrets(value, secrets).replace(/\s+/g, ' ').trim();
}

// Keeps the start of a value: used for curated messages and short row details.
export function boundedText(value, { secrets = [], limit = 300 } = {}) {
  const text = normalize(value, secrets);
  if (!text) return undefined;
  return text.length > limit ? `${cutHead(text, limit)}...` : text;
}

// Keeps the end of a value: the actionable line of a CLI stderr dump is the last
// one, so truncating a diagnostic from the front would hide the real reason.
export function boundedTail(value, { secrets = [], limit = 300 } = {}) {
  const text = normalize(value, secrets);
  if (!text) return undefined;
  return text.length > limit ? `...${cutTail(text, limit)}` : text;
}

export function stderrTail(source, lines = 3) {
  const stderr = source?.stderr ?? source?.details?.stderr;
  if (typeof stderr !== 'string') return '';
  return stderr.split('\n').map(line => line.trim()).filter(Boolean).slice(-lines).join(' | ');
}

function describeFailure({ code, message, hint, cliCode, stderr }, { secrets = [], limit = 600 } = {}) {
  const tail = stderrTail({ stderr });
  const curated = typeof message === 'string' ? message.trim() : '';
  // "OpenCLI exited with code N" is the runner's last-resort sentence; when stderr
  // has real text, that text is the reason worth showing.
  const fallbackOnly = !curated || /^OpenCLI exited with code \d+$/i.test(curated);
  const summary = {
    code: code ?? 'OPENCLI_MCP_ERROR',
    message: (fallbackOnly && tail
      ? boundedTail(tail, { secrets, limit })
      : boundedText(curated || tail || 'OpenCLI failed without a message', { secrets, limit })) ?? 'OpenCLI failed without a message',
  };
  // A hint is agent-facing prose too: the same redaction and size rules apply, and
  // a non-string hint is flattened instead of forwarded as an opaque object.
  const safeHint = hint === undefined || hint === null
    ? undefined
    : boundedText(typeof hint === 'string' ? hint : JSON.stringify(hint), { secrets, limit: 300 });
  if (safeHint) summary.hint = safeHint;
  else if (isNavigationRejected(summary.message) || isNavigationRejected(tail)) summary.hint = NAVIGATION_REJECTED_HINT;
  // cli_error_code is the CLI's own code: its structured code when it emitted one
  // (for example XHS_NOTE_ERROR), otherwise the runner code (an exit code or a
  // semantic string such as TIMEOUT). exit_code exists only for a numeric one.
  const ownCode = summary.code ?? cliCode;
  if (ownCode !== undefined && ownCode !== null) summary.cli_error_code = String(ownCode);
  if (typeof cliCode === 'number') summary.exit_code = cliCode;
  if (tail && tail !== summary.message) summary.stderr_tail = boundedTail(tail, { secrets, limit: 300 });
  return summary;
}

// Thrown shape: OpenCliError with details {code, stdout, stderr, data, invocation}.
export function summarizeFailure(error, options) {
  const details = error && typeof error === 'object' ? error.details : undefined;
  const structured = details?.data && typeof details.data === 'object' ? details.data.error : undefined;
  return describeFailure({
    code: structured?.code ?? details?.code ?? error?.code,
    message: structured?.message ?? error?.message,
    hint: structured?.hint,
    cliCode: details?.code,
    stderr: details?.stderr,
  }, options);
}

// Returned shape: the non-throwing result the media wrapper builds, or any
// injected runner that answers { ok: false, code, stderr, data, error }.
export function summarizeCliResult(cli, options) {
  const structured = cli?.data && typeof cli.data === 'object' ? cli.data.error : undefined;
  return describeFailure({
    code: structured?.code ?? cli?.code ?? cli?.error?.code,
    message: structured?.message ?? cli?.error?.message,
    hint: structured?.hint,
    cliCode: cli?.code ?? cli?.error?.code,
    stderr: cli?.stderr,
  }, options);
}
