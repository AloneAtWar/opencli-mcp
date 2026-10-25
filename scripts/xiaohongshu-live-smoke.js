// Pipe one complete signed note URL to stdin. Never put it on the command line.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, realpath, lstat, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = path.join(workspace, '.opencli-mcp', 'live-xhs');
class CheckFailure extends Error {}
const check = (condition, message) => { if (!condition) throw new CheckFailure(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function imageMime(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString())) return 'image/avif';
  return null;
}
let client;
let stage = 'read_note_url';
try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    check(input.length <= 65536, 'stdin exceeds the note URL input limit');
    if (input.includes('\n')) break;
  }
  const noteUrl = input.trim();
  let parsed;
  try { parsed = new URL(noteUrl); } catch { throw new CheckFailure('stdin must contain one complete note URL'); }
  check(parsed.protocol === 'https:' && /(^|\.)(xiaohongshu\.com|xhslink\.com)$/i.test(parsed.hostname), 'stdin must contain an HTTPS Xiaohongshu note URL');
  input = '';
  stage = 'connect';
  await mkdir(cacheRoot, { recursive: true });
  const expectedRoot = await realpath(cacheRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(workspace, 'bin', 'opencli-mcp.js')],
    cwd: workspace,
    env: { ...process.env, OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: expectedRoot, OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: '100', OPENCLI_XIAOHONGSHU_IMAGE_CACHE_MAX_FILES: '10' },
    stderr: 'pipe',
  });
  // Drain private CLI diagnostics without logging signed URLs or credentials.
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'xiaohongshu-live-smoke', version: '0.1.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  check(tools.some(tool => tool.name === 'opencli_run'), 'The opencli_run tool is missing');
  check(!tools.some(tool => tool.name.startsWith('xiaohongshu_')), 'Xiaohongshu media must go through opencli_run, not typed tools');
  stage = 'download';
  // Deliberately omit output: this tests server-side environment root selection.
  const download = await client.callTool({ name: 'opencli_run', arguments: { site: 'xiaohongshu', command: 'download', args: [noteUrl, '--timeout-ms', '180000'] } }, undefined, { timeout: 240000 });
  check(!download.isError, 'The opencli_run download returned a tool error');
  const metadata = download.structuredContent;
  check(metadata?.inventory_complete === true, 'The download inventory is incomplete');
  check(metadata.managed_cache === true && metadata.path_scope === 'server_local', 'The download cache scope is incorrect');
  check(metadata.download_root === expectedRoot, 'The download did not use the isolated environment root');
  check(metadata.directory_source === 'environment', 'The download did not report environment root selection');
  check(Array.isArray(metadata.files) && metadata.files.length > 0, 'No verified files were returned');
  const verified = [];
  for (const file of metadata.files) {
    check(path.isAbsolute(file.local_path), 'A downloaded file path is not absolute');
    check(file.local_path.startsWith(expectedRoot + path.sep), 'A downloaded file escaped the isolated root');
    const stat = await lstat(file.local_path);
    check(stat.isFile() && !stat.isSymbolicLink(), 'A downloaded path is not a regular file');
    check(await realpath(file.local_path) === file.local_path, 'A downloaded file path contains a link');
    check(stat.size === file.size_bytes, 'The reported file size differs from disk');
    verified.push({ ...file, actual_size_bytes: stat.size });
  }
  const candidates = verified.filter(file => file.mime_type.startsWith('image/')).flatMap(file => {
    const match = path.basename(file.local_path).match(/^(.*)_([1-9]\d*)\.[^.]+$/);
    return match && match[1] === path.basename(path.dirname(file.local_path)) ? [{ ...file, index: Number(match[2]) }] : [];
  }).sort((a,b) => a.index - b.index);
  check(candidates.length > 0, 'The note has no verified image with a known media index');
  const selected = candidates[0];
  check(selected.size_bytes <= 10 * 1024 * 1024, 'The first verified image exceeds the response limit');
  // Capture the baseline before the subsequent request can run cache cleanup.
  const baseline = await readFile(selected.local_path);
  check(imageMime(baseline) === selected.mime_type, 'The downloaded image MIME does not match its bytes');
  const baselineHash = hash(baseline);
  stage = 'images';
  const response = await client.callTool({ name: 'opencli_run', arguments: { site: 'xiaohongshu', command: 'images', args: [noteUrl, '--indexes', String(selected.index), '--timeout-ms', '180000'] } }, undefined, { timeout: 240000 });
  check(!response.isError, 'The opencli_run images call returned a tool error');
  const blocks = response.content.filter(block => block.type === 'image');
  check(blocks.length === 1, 'The images call did not return exactly one native ImageContent');
  const imageMetadata = response.structuredContent;
  check(imageMetadata?.images?.length === 1, 'Image metadata does not describe one image');
  const item = imageMetadata.images[0], bytes = Buffer.from(blocks[0].data, 'base64');
  check(item.index === selected.index, 'The returned media index differs from the selected index');
  check(bytes.length > 0 && bytes.length <= 10 * 1024 * 1024 && bytes.length === item.size_bytes, 'The returned image has an invalid size');
  check(imageMime(bytes) === blocks[0].mimeType && item.mime_type === blocks[0].mimeType, 'Native ImageContent MIME does not match the bytes');
  check(hash(bytes) === baselineHash, 'The native ImageContent bytes differ from the downloaded image');
  const serialized = JSON.stringify(imageMetadata);
  check(!serialized.includes(expectedRoot) && !/download_root|output_directory|local_path|xsec_token/i.test(serialized), 'Image metadata exposes private paths or token fields');
  const token = parsed.searchParams.get('xsec_token');
  check(!token || (!serialized.includes(token) && !JSON.stringify(metadata).includes(token)), 'A signed token appeared in media metadata');
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }[blocks[0].mimeType];
  const preview = path.join(expectedRoot, `response-preview.${extension}`);
  await writeFile(preview, bytes);
  console.log(JSON.stringify({
    ok: true,
    isolated_root: expectedRoot,
    download: { status: metadata.status, directory_source: metadata.directory_source, inventory_complete: metadata.inventory_complete, output_directory: metadata.output_directory, file_count: verified.length, files: verified.map(file => ({ local_path: file.local_path, size_bytes: file.actual_size_bytes, mime_type: file.mime_type })) },
    images: { status: imageMetadata.status, count: blocks.length, index: item.index, size_bytes: bytes.length, mime_type: blocks[0].mimeType, sha256: baselineHash, matches_download_bytes: true, error_codes: (imageMetadata.errors ?? []).map(error => error.code), preview_path: preview },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, stage, error: error instanceof CheckFailure ? error.message : 'Live MCP or filesystem operation failed; raw diagnostics withheld to protect signed URLs' }));
  process.exitCode = 1;
} finally {
  try { await client?.close(); } catch { /* Preserve the primary verification outcome. */ }
}
