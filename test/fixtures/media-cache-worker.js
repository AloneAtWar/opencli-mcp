// Real independent MCP-like process used by the shared-cache regression tests.
// All paths and media bytes are supplied by the parent test's temporary root.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import lockfile from 'proper-lockfile';

const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const finish = async message => { await send(message); process.disconnect(); };

process.once('message', async (options) => {
  try {
    const { root } = options;
    if (options.operation === 'hold_lock') {
      await lockfile.lock(root, { lockfilePath: path.join(root, '.opencli-xhs-owned.json.lock'), stale: 10_000, update: 2_000 });
      setInterval(() => {}, 1000);
      await send({ type: 'held' });
      return;
    }

    if (options.pauseManifest) {
      const originalWrite = fs.writeFile;
      fs.writeFile = async (...args) => {
        const value = await originalWrite(...args);
        if (path.basename(String(args[0])).startsWith('.opencli-xhs-owned.json.') && String(args[0]).endsWith('.tmp')) {
          fs.writeFile = originalWrite;
          await send({ type: 'paused' });
          await once(process, 'message');
        }
        return value;
      };
      const originalLock = lockfile.lock;
      lockfile.lock = (file, settings) => originalLock(file, {
        ...settings,
        onCompromised: error => {
          process.send({ type: 'compromised', code: error.code });
          settings.onCompromised(error);
        },
      });
      syncBuiltinESMExports();
    }

    let pausedRead = false;
    if (options.pauseInventory || options.failInventory) {
      const originalOpen = fs.open;
      fs.open = async (...args) => {
        if (!pausedRead && path.basename(String(args[0])) === 'note_1.jpg') {
          pausedRead = true;
          if (options.failInventory) throw Object.assign(new Error('simulated image read failure'), { code: 'EACCES' });
          await send({ type: 'reading' });
          await once(process, 'message');
        }
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
    }

    const { createXiaohongshuMedia } = await import('../../src/xiaohongshu-media.js');
    const media = createXiaohongshuMedia({
      env: {
        OPENCLI_XIAOHONGSHU_DOWNLOAD_DIR: root,
        OPENCLI_XIAOHONGSHU_DOWNLOAD_CACHE_MAX_MB: String(options.maxMb ?? 100),
      },
      run: async args => {
        const directory = args[args.indexOf('--output') + 1];
        await fs.mkdir(path.join(directory, 'note'), { recursive: true });
        const bytes = Buffer.alloc(600_000);
        Buffer.from('ffd8ffe000104a4649460001', 'hex').copy(bytes);
        await fs.writeFile(path.join(directory, 'note', 'note_1.jpg'), bytes);
        await send({ type: 'started', directory });
        if (options.pauseDownload) await once(process, 'message');
        return { ok: true, data: [{ index: 1, type: 'image', status: 'success' }] };
      },
    });
    const result = await media[options.operation ?? 'download']({ note_url: 'https://xhslink.com/test' });
    await finish({ type: 'result', data: result.structuredContent });
  } catch (error) {
    await finish({ type: 'result', error: { code: error.code, message: error.message } });
  }
});

await send({ type: 'ready' });
