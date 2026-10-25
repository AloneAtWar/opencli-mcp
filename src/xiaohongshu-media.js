import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, lstat, realpath, open, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { boundedText, isNavigationRejected, redactSecrets, summarizeCliResult, summarizeFailure, urlSecrets } from './cli-failure.js';

const CONTAINER = 'opencli-xhs-images';
const MANIFEST = '.opencli-xhs-owned.json';
const active = new Set();
const quarantined = new Set();
const locks = new Map();
const MIB = 1024 * 1024;
// Per-response limits for the images subcommand (one constant per limit so the
// code, the error text and the help line cannot drift apart).
const MAX_RESPONSE_IMAGES = 20;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_TOTAL_IMAGE_BYTES = 20 * MIB;
// ChatGPT drops a tool result that carries more than one image block outright:
// the text block disappears with it. One block renders fine, so the per-response
// image-block budget defaults to one; it is not a resource cap (the limits above
// still apply) and clients that handle several images can raise it, up to 20.
const DEFAULT_IMAGE_BLOCKS_PER_RESPONSE = 1;
const IMAGE_BLOCKS_PER_RESPONSE_ENV = 'OPENCLI_XIAOHONGSHU_IMAGE_BLOCKS_PER_RESPONSE';
const CLEANUP_PENDING = { code: 'CLEANUP_PENDING', message: 'Managed-cache cleanup could not finish; the cache may stay over its budget until a later call retries' };
// OPENCLI_SITE_SESSION is a session *lifecycle* (ephemeral | persistent), not a
// session name. A refused navigation under the default ephemeral adapter window
// is retried as persistent, and an explicitly persistent run is retried as
// ephemeral, so the replay starts on a different lifecycle instead of reusing
// the tab that could not navigate.
function retrySessionFor(env) {
  return String(env?.OPENCLI_SITE_SESSION) === 'persistent' ? 'ephemeral' : 'persistent';
}
// TIMEOUT / OUTPUT_LIMIT are the runner's codes for "we stopped the process".
// They carry quarantine semantics (the writer may still be alive), so they must
// never be mistaken for a replayable failure just because the text happens to
// mention a rejected navigation.
const TERMINATION_CODES = /TIMEOUT|OUTPUT_LIMIT/i;
const isTerminationFailure = (error) => TERMINATION_CODES.test(String(error?.details?.code ?? error?.code));
const IMAGES_HELP = [
  'opencli_run(site="xiaohongshu", command="images") returns one note\'s images as native MCP ImageContent.',
  '',
  'args:',
  '  <note-url>            first positional: full note URL carrying its xsec_token, or an xhslink.com short link',
  '  --indexes 1,3         comma-separated 1-based original media indices (repeatable; default: every image)',
  '  --index 1             one 1-based original media index (repeatable)',
  '  --timeout-ms 60000    CLI download timeout in ms (default 90000, hard max 600000)',
  '',
  'returns: content[] image blocks plus a JSON metadata block; structuredContent.status/images/errors.',
  `limits: ${DEFAULT_IMAGE_BLOCKS_PER_RESPONSE} image block per response by default (${IMAGE_BLOCKS_PER_RESPONSE_ENV}, max ${MAX_RESPONSE_IMAGES}; extra requested indexes go to skipped_indexes), ${MAX_IMAGE_BYTES / MIB} MiB each, ${MAX_TOTAL_IMAGE_BYTES / MIB} MiB total; byte overruns are reported in errors[].`,
  'No output argument: the success payload carries no local paths, though a CLI failure message may quote one. Root: OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR, else the server OS Downloads folder.',
].join('\n');
function positiveIntegerArg(value, label) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}
function indexListArg(value, label) {
  const parts = String(value).split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`${label} requires at least one index`);
  return parts.map((part) => positiveIntegerArg(part, label));
}
function locked(root, action) {
  const previous = locks.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(root, next);
  return next.finally(() => { if (locks.get(root) === next) locks.delete(root); });
}
function positive(env, key, fallback) {
  const value = env[key];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} must be a positive integer`);
  return Number(value);
}
function resolveImageBlocksPerResponse(env) {
  return Math.min(MAX_RESPONSE_IMAGES, positive(env, IMAGE_BLOCKS_PER_RESPONSE_ENV, DEFAULT_IMAGE_BLOCKS_PER_RESPONSE));
}
export function resolveDownloadRoot(env = process.env, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const home = deps.homeDir ?? os.homedir();
  const cwd = deps.cwd ?? process.cwd();
  const p = platform === 'win32' ? path.win32 : path.posix;
  let selected, source;
  if (deps.output !== undefined) {
    if (typeof deps.output !== 'string' || !deps.output.trim()) throw new Error('output must be a non-empty path');
    selected = deps.output; source = 'explicit_output';
  } else if (env.OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR?.trim()) {
    selected = env.OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR.trim(); source = 'environment';
  } else {
    let downloads = deps.osDownloadsDir;
    if (!Object.hasOwn(deps, 'osDownloadsDir')) {
      try {
        if (platform === 'win32') {
          const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', '{374DE290-123F-4565-9164-39C4925E467B}'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
          downloads = output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim().replace(/%([^%]+)%/g, (_, key) => env[key] ?? (key.toUpperCase() === 'USERPROFILE' ? home : `%${key}%`));
        } else if (platform === 'linux') {
          const file = p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'user-dirs.dirs');
          if ((deps.existsSync ?? existsSync)(file)) downloads = (deps.readFileSync ?? readFileSync)(file, 'utf8').match(/^XDG_DOWNLOAD_DIR="([^"]+)"/m)?.[1]?.replace(/\$\{HOME\}|\$HOME/g, home);
        } else if (platform === 'darwin') downloads = p.join(home, 'Downloads');
      } catch { /* The documented user Downloads fallback remains available. */ }
    }
    if (downloads && (!p.isAbsolute(downloads) || /%[^%]+%|\$(?:HOME|\{HOME\})/.test(downloads))) downloads = null;
    selected = downloads || p.join(home, 'Downloads');
    source = downloads ? 'os_downloads' : 'os_downloads_fallback';
  }
  if (platform === 'win32' && /^[a-z]:(?![\\/])/i.test(selected)) throw new Error(`Windows drive-relative paths are unsupported: ${selected}`);
  if (platform !== 'win32' && (/^[a-z]:/i.test(selected) || /^\\\\/.test(selected))) throw new Error('Foreign Windows paths are unsupported on this server platform');
  return { download_root: p.resolve(cwd, selected), directory_source: source };
}
function mime(bytes, filename = '') {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return /avif|avis/.test(bytes.subarray(8, 32).toString()) ? 'image/avif' : 'video/mp4';
  return 'application/octet-stream';
}
async function regularFiles(dir) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name), stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files.push({ local_path: full, size_bytes: stat.size, mtime: stat.mtimeMs });
    }
  }
  await walk(dir);
  return files;
}
async function pruneEmpty(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await pruneEmpty(path.join(dir, entry.name));
  }
  if (!(await readdir(dir)).length) await rm(dir, { recursive: true });
}
async function inventory(dir) {
  const root = await realpath(dir), files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name), stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      const resolved = await realpath(full);
      if (!resolved.startsWith(root + path.sep)) continue;
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile() && !/\.(tmp|part|partial|download)$/i.test(entry.name)) {
        const handle = await open(full, 'r');
        try {
          const header = Buffer.alloc(32), { bytesRead } = await handle.read(header, 0, 32, 0);
          files.push({ local_path: resolved, size_bytes: stat.size, mime_type: mime(header.subarray(0, bytesRead), entry.name), mtime: stat.mtimeMs });
        } finally { await handle.close(); }
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.local_path.localeCompare(b.local_path, undefined, { numeric: true }));
}
async function manifest(root) {
  try {
    const stat = await lstat(path.join(root, MANIFEST));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe ownership manifest');
    const data = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('Invalid ownership manifest');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, tasks: [] }; throw error; }
}
async function saveManifest(root, data) {
  const temporary = path.join(root, `${MANIFEST}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(data), { flag: 'wx' });
  await rename(temporary, path.join(root, MANIFEST));
}
function taskPath(root, task) {
  if (!/^opencli-xhs-\d+-[a-f0-9-]+$/.test(task.name) || !['images', 'download'].includes(task.kind)) return null;
  return path.join(root, ...(task.kind === 'images' ? [CONTAINER] : []), task.name);
}
async function cleanup(root, maxBytes, maxImages, protect) {
  return locked(root, async () => {
    const data = await manifest(root), tasks = [], errors = [];
    for (const task of data.tasks) {
      const dir = taskPath(root, task);
      if (!dir) continue;
      try {
        const stat = await lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(dir)) !== dir) continue;
        // Size accounting never opens media bytes, including files still being written.
        tasks.push({ ...task, dir, protected: active.has(dir) || quarantined.has(dir) || task.quarantined, files: await regularFiles(dir) });
      } catch (error) { if (error.code !== 'ENOENT') errors.push({ ...CLEANUP_PENDING }); }
    }
    const imageFiles = [];
    for (const task of tasks.filter(t => t.kind === 'images' && !t.protected)) {
      const verifiedImages = new Set((await inventory(task.dir)).filter(file => file.mime_type.startsWith('image/')).map(file => file.local_path));
      for (const file of task.files) {
        if (verifiedImages.has(file.local_path)) imageFiles.push(file);
        else if (dirEligible(task.dir)) { try { await rm(file.local_path); } catch { errors.push({ ...CLEANUP_PENDING }); } }
      }
    }
    imageFiles.sort((a,b) => a.mtime - b.mtime || a.local_path.localeCompare(b.local_path));
    for (const file of imageFiles.slice(0, Math.max(0, imageFiles.length - maxImages))) {
      try { await rm(file.local_path); } catch { errors.push({ ...CLEANUP_PENDING }); }
    }
    let total = 0;
    for (const task of tasks) { task.files = await regularFiles(task.dir); task.size = task.files.reduce((sum,f) => sum + f.size_bytes, 0); total += task.size; }
    tasks.sort((a,b) => a.created - b.created || a.name.localeCompare(b.name));
    for (const task of tasks) {
      if (total <= maxBytes) break;
      if (task.dir === protect || task.protected || active.has(task.dir)) continue;
      try { await rm(task.dir, { recursive: true }); total -= task.size; data.tasks = data.tasks.filter(t => t.name !== task.name); }
      catch { errors.push({ ...CLEANUP_PENDING }); }
    }
    for (const task of tasks.filter(t => t.kind === 'images' && !t.protected && !active.has(t.dir) && t.dir !== protect)) {
      try { await pruneEmpty(task.dir); } catch (error) { if (error.code !== 'ENOENT') errors.push({ ...CLEANUP_PENDING }); }
    }
    const retained = [];
    for (const task of data.tasks) { const dir = taskPath(root, task); if (dir && existsSync(dir)) retained.push(task); }
    data.tasks = retained;
    await saveManifest(root, data);
    return errors;
  });
  function dirEligible(dir) { return !active.has(dir); }
}
function result(data, blocks = [], isError = data.status === 'error') {
  return { content: [...blocks, { type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}
function redact(value, noteUrl) {
  const secrets = urlSecrets(noteUrl);
  const visit = item => {
    if (typeof item === 'string') return redactSecrets(item, secrets);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !/cookie|authorization|xsec_token|stdout|stderr|invocation|args|command/i.test(key)).map(([key, val]) => [key, visit(val)]));
    return item;
  };
  return visit(value);
}
function primaryError(errors) {
  const entries = errors.filter(entry => entry && typeof entry.code === 'string');
  const first = entries.find(entry => entry.code !== 'CLEANUP_PENDING') ?? entries[0];
  if (!first) return undefined;
  return {
    code: first.code,
    message: first.message ?? first.detail ?? `Media operation reported ${first.code}`,
    ...(first.index === undefined ? {} : { index: first.index }),
    ...(first.available_indexes ? { available_indexes: first.available_indexes } : {}),
    ...(first.cli_error_code ? { cli_error_code: first.cli_error_code } : {}),
    ...(first.exit_code === undefined ? {} : { exit_code: first.exit_code }),
    ...(first.hint === undefined ? {} : { hint: first.hint }),
    ...(first.stderr_tail === undefined ? {} : { stderr_tail: first.stderr_tail }),
  };
}
// Effective media-cache configuration. A long-lived server inherits its
// environment at start, so an operator needs a way to see which root and limits
// this process actually got instead of guessing.
export function describeMediaCache(env = process.env, cwd = process.cwd()) {
  try {
    const resolved = resolveDownloadRoot(env, { cwd });
    return {
      download_root: resolved.download_root,
      directory_source: resolved.directory_source,
      image_cache_max_files: positive(env, 'OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES', 10),
      download_cache_max_mb: positive(env, 'OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB', 100),
      image_blocks_per_response: resolveImageBlocksPerResponse(env),
    };
  } catch (error) {
    return { error: error.message };
  }
}
export function createXiaohongshuMedia({ run, env = process.env, cwd = process.cwd() }) {
  async function clean(root, maxBytes, maxImages, protect) {
    try { return await cleanup(root, maxBytes, maxImages, protect); }
    catch { return [{ ...CLEANUP_PENDING }]; }
  }
  // Media errors reuse the shared summary fields verbatim, so a media result and
  // the generic tool-error payload can never disagree about the same CLI failure.
  function summaryExtras(summary) {
    return {
      ...(summary?.hint === undefined ? {} : { hint: summary.hint }),
      ...(summary?.cli_error_code === undefined ? {} : { cli_error_code: summary.cli_error_code }),
      ...(summary?.exit_code === undefined ? {} : { exit_code: summary.exit_code }),
      ...(summary?.stderr_tail === undefined ? {} : { stderr_tail: summary.stderr_tail }),
    };
  }
  // The wrapper owns its result format, so the internal CLI call is always JSON:
  // a non-JSON format would turn the per-media failure rows into an opaque string
  // and silently hide partial failures.
  async function execute(input, kind, extra = []) {
    if (typeof input.note_url !== 'string' || !input.note_url.trim()) throw new Error('note_url is required');
    const secrets = urlSecrets(input.note_url);
    if (run.executionPlatform && run.executionPlatform !== process.platform) throw new Error('Cross-OS media downloads are unsupported: execution platform differs from server');
    const maxBytes = positive(env, 'OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB', 100) * 1000000;
    const maxImages = positive(env, 'OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES', 10);
    const imageBlockBudget = resolveImageBlocksPerResponse(env);
    if (kind === 'images' && input.output !== undefined) throw new Error('images does not accept output');
    if (input.image_indexes !== undefined && (!Array.isArray(input.image_indexes) || input.image_indexes.some(i => !Number.isSafeInteger(i) || i < 1) || new Set(input.image_indexes).size !== input.image_indexes.length)) throw new Error('image_indexes must contain unique positive integers');
    const resolved = resolveDownloadRoot(env, { output: input.output, cwd });
    await mkdir(resolved.download_root, { recursive: true });
    const root = await realpath(resolved.download_root);
    const parent = kind === 'images' ? path.join(root, CONTAINER) : root;
    await mkdir(parent, { recursive: true });
    if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent) throw new Error('Unsafe images container');
    const name = `opencli-xhs-${Date.now()}-${randomUUID()}`, dir = path.join(parent, name);
    active.add(dir);
    let cli, failure, files = [], complete = true, unconfirmed = false, retry;
    // Chrome can refuse the first navigation when the automation tab was closed
    // or replaced between lease resolution and tabs.update. These commands only
    // read the note and write into this call's own directory, so one replay on a
    // separate browser session is safe and usually lands on a fresh tab.
    const callOnce = (session) => run(
      ['xiaohongshu', 'download', input.note_url, ...extra, '--output', dir, '-f', 'json'],
      { timeoutMs: input.timeout_ms, ...(session ? { env: { OPENCLI_SITE_SESSION: session } } : {}) },
    );
    const recordFailure = async (error) => {
      failure = error;
      cli = { ok: false, ...error.details, error: { code: error.details?.code ?? error.code ?? 'CLI_ERROR', message: error.message } };
      const stoppedError = isTerminationFailure(error);
      complete = !stoppedError;
      unconfirmed = stoppedError && error.details?.termination_confirmed !== true;
      if (unconfirmed) {
        quarantined.add(dir);
        await locked(root, async () => { const data = await manifest(root); const task = data.tasks.find(t => t.name === name); if (task) task.quarantined = true; await saveManifest(root, data); });
      }
    };
    try {
      // A crashed or unconfirmed writer stays quarantined across server restarts.
      await locked(root, async () => { await mkdir(dir); const data = await manifest(root); const created = Math.max(Date.now(), ...data.tasks.map(t => (Number(t.created) || 0) + 1)); data.tasks.push({ name, kind, created, quarantined: true }); await saveManifest(root, data); });
      try { cli = await callOnce(); }
      catch (error) {
        // A stopped run may leave a live process still writing into this
        // directory, so it always takes the quarantine path: replaying it would
        // let a half-written directory be reported as this call's inventory.
        if (isTerminationFailure(error) || !isNavigationRejected(error)) {
          await recordFailure(error);
        } else {
          const session = retrySessionFor(env);
          retry = { reason: 'navigation_rejected', attempts: 2, session };
          // The first attempt may have left files behind before its navigation was
          // refused. The replay owns this request directory, so it starts clean:
          // only a normally-exited run reaches this branch (a stopped run takes the
          // quarantine path above), so nothing is still writing here.
          await locked(root, async () => { await rm(dir, { recursive: true, force: true }); await mkdir(dir); });
          try {
            cli = await callOnce(session);
            // outcome is filled in from the final status below: a replay that
            // returns while the CLI still reported per-item failures resolved
            // nothing, so it must not be recorded as a success.
          } catch (retryError) {
            await recordFailure(retryError);
            retry.outcome = 'failed';
          }
        }
      }
      if (!unconfirmed) await locked(root, async () => { const data = await manifest(root); const task = data.tasks.find(t => t.name === name); if (task) task.quarantined = false; await saveManifest(root, data); });
      if (!unconfirmed) files = await inventory(dir);
      const rows = Array.isArray(cli?.data) ? cli.data : [];
      const failedRows = rows.filter(row => row && typeof row === 'object' && typeof row.status === 'string' && /^(error|failed|failure)$/i.test(row.status));
      const cliFailed = failure || cli?.ok === false || failedRows.length > 0 || files.length === 0;
      if (kind === 'download') {
        const cleanupErrors = await clean(root, maxBytes, maxImages, dir);
        const status = cliFailed ? (files.length ? 'partial' : 'error') : 'success';
        if (retry && retry.outcome === undefined) retry.outcome = status;
        const failedIndexes = failedRows.map(row => row.index).filter(index => Number.isSafeInteger(index));
        const failedDetail = failedRows.map(row => boundedText(row.size, { secrets, limit: 300 })).find(Boolean);
        const failureSummary = failure
          ? summarizeFailure(failure, { secrets, limit: 600 })
          : cli?.ok === false
            ? summarizeCliResult(cli, { secrets, limit: 600 })
            : undefined;
        const error = status === 'success' ? undefined : {
          code: failure || cli?.ok === false ? 'CLI_ERROR' : 'MEDIA_DOWNLOAD_FAILED',
          message: failedRows.length
            ? `${failedRows.length} media item(s) failed; first reason: ${failedDetail ?? 'the CLI reported no reason'}`
            : failureSummary?.message ?? 'The CLI did not complete the request and reported no reason',
          ...(failedIndexes.length ? { failed_indexes: failedIndexes } : {}),
          ...summaryExtras(failureSummary),
        };
        return result({ status, path_scope: 'server_local', server_platform: process.platform, managed_cache: true, download_root: root, output_directory: dir, directory_source: resolved.directory_source, files: files.map(({ mtime, ...file }) => file), cli_result: redact(cli, input.note_url), inventory_complete: complete, errors: cleanupErrors, ...(retry ? { retry } : {}), ...(error ? { error } : {}) });
      }
      const blocks = [], images = [], errors = [];
      if (failure) {
        const summary = summarizeFailure(failure, { secrets, limit: 600 });
        errors.push({ code: unconfirmed ? 'TERMINATION_UNCONFIRMED' : 'CLI_ERROR', message: summary.message, ...summaryExtras(summary) });
      } else if (cli?.ok === false && !failedRows.length) {
        const summary = summarizeCliResult(cli, { secrets, limit: 600 });
        errors.push({ code: 'CLI_ERROR', message: summary.message, ...summaryExtras(summary) });
      }
      for (const row of failedRows) if (row.type === 'image' && Number.isSafeInteger(row.index) && row.index > 0 && (!input.image_indexes || input.image_indexes.includes(row.index))) {
        const detail = boundedText(row.size, { secrets, limit: 300 });
        errors.push({ index: row.index, code: 'IMAGE_DOWNLOAD_FAILED', message: `The CLI could not download media index ${row.index}${detail ? `: ${detail}` : ''}`, ...(detail ? { detail } : {}) });
      }
      let candidates = files.filter(f => f.mime_type.startsWith('image/')).flatMap(file => {
        const relative = path.relative(dir, file.local_path).split(path.sep);
        if (relative.length !== 2) { errors.push({ code: 'IMAGE_INDEX_UNMAPPABLE', message: 'A downloaded image is not directly inside a single <note-id> directory, so its media index cannot be derived from its filename' }); return []; }
        const match = relative[1].match(/^(.*)_([1-9]\d*)\.[^.]+$/);
        if (!match || match[1] !== relative[0] || !Number.isSafeInteger(Number(match[2]))) { errors.push({ code: 'IMAGE_INDEX_UNMAPPABLE', message: `Filename ${relative[1]} does not follow the <note-id>_<n>.<ext> pattern` }); return []; }
        return [{ ...file, index: Number(match[2]), noteId: relative[0] }];
      });
      if (new Set(candidates.map(file => file.noteId)).size > 1) { errors.push({ code: 'IMAGE_INDEX_AMBIGUOUS', message: 'Downloaded images belong to more than one note id, so media indexes are ambiguous' }); candidates = []; }
      const duplicateIndexes = new Set(candidates.filter((file, offset, all) => all.findIndex(other => other.index === file.index) !== offset).map(file => file.index));
      for (const index of duplicateIndexes) errors.push({ index, code: 'IMAGE_INDEX_AMBIGUOUS', message: `More than one downloaded image maps to media index ${index}` });
      candidates = candidates.filter(file => !duplicateIndexes.has(file.index)).sort((a,b) => a.index - b.index);
      const availableIndexes = candidates.map(file => file.index);
      const selected = input.image_indexes ? [...input.image_indexes].sort((a,b) => a - b) : availableIndexes;
      let total = 0;
      const skippedIndexes = [];
      for (const index of selected) {
        const file = candidates.find(f => f.index === index);
        if (!file) { errors.push({ index, code: 'IMAGE_NOT_FOUND', available_indexes: availableIndexes, message: `The CLI downloaded no image for media index ${index}${availableIndexes.length ? `; available image indexes: ${availableIndexes.join(', ')}` : '; this note produced no image files'}` }); continue; }
        // Extra requested indexes are paging, not an error: ChatGPT drops a
        // result that carries several image blocks, so the caller asks for the
        // rest with --indexes once it has consumed this one.
        if (images.length >= imageBlockBudget) { skippedIndexes.push(index); continue; }
        if (file.size_bytes > MAX_IMAGE_BYTES || total + file.size_bytes > MAX_TOTAL_IMAGE_BYTES) { errors.push({ index, code: 'IMAGE_LIMIT', size_bytes: file.size_bytes, message: `Media index ${index} exceeds the response byte limits (at most ${MAX_IMAGE_BYTES / MIB} MiB each, ${MAX_TOTAL_IMAGE_BYTES / MIB} MiB total)` }); continue; }
        let handle;
        try {
          const stat = await lstat(file.local_path);
          if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file.local_path) !== file.local_path || stat.size > MAX_IMAGE_BYTES) throw new Error('Unsafe image');
          handle = await open(file.local_path, 'r');
          const opened = await handle.stat();
          if (opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Changed image');
          const bytes = Buffer.alloc(stat.size + 1);
          let count = 0;
          while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
          if (count !== stat.size || total + count > MAX_TOTAL_IMAGE_BYTES) throw new Error('Changed image size');
          const data = bytes.subarray(0, count), type = mime(data);
          if (!type.startsWith('image/')) throw new Error('Unrecognized image bytes');
          blocks.push({ type: 'image', data: data.toString('base64'), mimeType: type }); images.push({ index, mime_type: type, size_bytes: count }); total += count;
        } catch { errors.push({ index, code: 'IMAGE_READ_FAILED', message: `Media index ${index} could not be read as a safe, unchanged image file` }); }
        finally { await handle?.close(); }
      }
      if (!images.length && !errors.length) errors.push({ code: 'NO_IMAGES', message: 'The CLI downloaded no images for this note' });
      active.delete(dir);
      errors.push(...await clean(root, maxBytes, maxImages, null));
      const status = errors.length ? (images.length ? 'partial' : 'error') : 'success';
      if (retry && retry.outcome === undefined) retry.outcome = status;
      const error = status === 'success' ? undefined : primaryError(errors);
      const noteIds = [...new Set(files.flatMap(file => { const relative = path.relative(dir, file.local_path).split(path.sep); return relative.length > 1 ? [relative[0]] : []; }))];
      return result({ status, managed_cache: true, inventory_complete: complete, ...(noteIds.length === 1 ? { note_id: noteIds[0] } : {}), available_indexes: availableIndexes, image_blocks_per_response: imageBlockBudget, ...(skippedIndexes.length ? { skipped_indexes: skippedIndexes } : {}), images, errors, ...(retry ? { retry } : {}), ...(error ? { error } : {}) }, blocks);
    } finally { active.delete(dir); }
  }
  return {
    download: input => execute(input, 'download'),
    images: input => execute(input, 'images'),
    async runDownload(args, { format = 'json', timeoutMs, timeout_ms } = {}) {
      if (args.includes('--help') || args.includes('-h')) {
        const cli = await run(['xiaohongshu', 'download', ...args, '-f', format], { timeoutMs: timeout_ms ?? timeoutMs });
        const cliHelp = String(redact(cli?.data ?? cli?.stdout ?? '', args.find(arg => /^https?:\/\//.test(arg)) ?? '') ?? '');
        const wrapperNote = '\n\nMCP wrapper: --output sets the server-local download root (default OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR, else the OS Downloads folder) and --timeout-ms sets the CLI timeout. The wrapper always parses the CLI output as JSON internally and reports verified absolute paths plus a top-level error when the download is not fully successful, so the generic format argument does not change the media result.';
        return result({ status: cli?.ok === false ? 'error' : 'success', help: `${cliHelp}${wrapperNote}`, cli_result: redact(cli, '') });
      }
      const rest = [], outputs = [], urls = [];
      let timeout;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--output') { if (i + 1 >= args.length) throw new Error('--output requires a path'); outputs.push(args[++i]); }
        else if (arg.startsWith('--output=')) outputs.push(arg.slice(9));
        else if (arg === '--timeout-ms') { if (i + 1 >= args.length) throw new Error('--timeout-ms requires milliseconds'); timeout = positiveIntegerArg(args[++i], '--timeout-ms'); if (timeout > 600000) throw new Error('--timeout-ms must be at most 600000'); }
        else if (arg.startsWith('--timeout-ms=')) { timeout = positiveIntegerArg(arg.slice(13), '--timeout-ms'); if (timeout > 600000) throw new Error('--timeout-ms must be at most 600000'); }
        else if (arg === '-f' || arg === '--format' || arg.startsWith('--format=')) throw new Error('Conflicting format arguments');
        else if (!arg.startsWith('-') && urls.length === 0) urls.push(arg);
        else rest.push(arg);
      }
      if (outputs.length > 1) throw new Error('Duplicate --output arguments');
      return execute({ note_url: urls[0], output: outputs[0], timeout_ms: timeout ?? timeout_ms ?? timeoutMs }, 'download', rest);
    },
    async runImages(args, { format = 'json', timeoutMs, timeout_ms } = {}) {
      if (args.includes('--help') || args.includes('-h')) return result({ status: 'success', help: IMAGES_HELP });
      const urls = [], indexes = [], unsupported = [];
      let timeout;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const eq = arg.startsWith('-') ? arg.indexOf('=') : -1;
        const flag = eq >= 0 ? arg.slice(0, eq) : arg;
        const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
        if (flag === '--indexes' || flag === '--image-indexes') {
          const value = inline ?? args[++i];
          if (value === undefined) throw new Error(`${flag} requires a comma-separated index list`);
          indexes.push(...indexListArg(value, flag));
        } else if (flag === '--index') {
          const value = inline ?? args[++i];
          if (value === undefined) throw new Error('--index requires a positive integer');
          indexes.push(positiveIntegerArg(value, '--index'));
        } else if (flag === '--timeout-ms') {
          const value = inline ?? args[++i];
          if (value === undefined) throw new Error(`${flag} requires milliseconds`);
          timeout = positiveIntegerArg(value, flag);
          if (timeout > 600000) throw new Error(`${flag} must be at most 600000`);
        } else if (flag === '--output' || flag === '-o') {
          throw new Error('images does not accept output; set OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR or use command="download"');
        } else if (arg === '-f' || flag === '--format') {
          throw new Error('Conflicting format arguments');
        } else if (!arg.startsWith('-') && urls.length === 0) urls.push(arg);
        else unsupported.push(arg);
      }
      if (unsupported.length) throw new Error(`Unsupported images argument(s): ${unsupported.join(' ')}; run args=["--help"] for the supported set`);
      if (new Set(indexes).size !== indexes.length) throw new Error('Duplicate media index');
      return execute({ note_url: urls[0], image_indexes: indexes.length ? indexes : undefined, timeout_ms: timeout ?? timeout_ms ?? timeoutMs }, 'images');
    },
  };
}
