// Per-site concurrency gate for adapter calls.
//
// OpenCLI already paces a single invocation: Xiaohongshu's risk-control helper
// waits a jittered settle before every page read and cools down before its one
// retry. What no layer caps is how many independent CLI processes the MCP server
// starts, so several parallel calls for one site defeat that in-process pacing.
// This gate limits calls per site and fails fast instead of queueing without
// bound.
//
// Pacing is deliberately absent here. An interval or jitter at this layer would
// duplicate what every CLI invocation already does; only the cross-call
// dimension is added.

export const DEFAULT_SITE_CONCURRENCY = 1;
export const DEFAULT_SITE_QUEUE_MAX = 8;
export const DEFAULT_SITE_QUEUE_WAIT_MS = 30_000;

// Every knob is range-checked: an out-of-range value silently becomes worse
// than useless (concurrency 0 queues every call, a fractional limit lets one
// extra call through, and Node clamps a timeout above 2**31-1 to 1ms).
const LIMITS = {
  concurrency: { min: 1, max: 64 },
  queueMax: { min: 1, max: 256 },
  queueWaitMs: { min: 1, max: 2_147_483_647 },
};

const BUSY_HINT =
  "Another call for the same site is still running. Wait for it to finish, then retry; do not retry in parallel.";

export class SiteBusyError extends Error {
  constructor(message, { site, reason, queueWaitMs } = {}) {
    super(message);
    this.name = "SiteBusyError";
    // errorResult() forwards this shape verbatim so a caller sees the same error
    // contract as an OpenCLI failure without pretending a CLI process ran.
    this.mcpError = {
      code: "SITE_BUSY",
      message,
      site,
      reason,
      hint: BUSY_HINT,
      ...(queueWaitMs === undefined ? {} : { queue_wait_ms: queueWaitMs }),
    };
  }
}

function boundedInt(value, fallback, { min, max }) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// An explicit option is validated against the same range as its environment
// variable and falls back to the resolved setting when it is unusable.
function resolveSetting(explicit, fallback, range) {
  return explicit === undefined ? fallback : boundedInt(explicit, fallback, range);
}

export function siteGateOptions(env = process.env) {
  return {
    concurrency: boundedInt(env.OPENCLI_MCP_SITE_CONCURRENCY, DEFAULT_SITE_CONCURRENCY, LIMITS.concurrency),
    queueMax: boundedInt(env.OPENCLI_MCP_SITE_QUEUE_MAX, DEFAULT_SITE_QUEUE_MAX, LIMITS.queueMax),
    queueWaitMs: boundedInt(env.OPENCLI_MCP_SITE_QUEUE_WAIT_MS, DEFAULT_SITE_QUEUE_WAIT_MS, LIMITS.queueWaitMs),
  };
}

export function createSiteGate({ env = process.env, concurrency, queueMax, queueWaitMs } = {}) {
  const parsed = siteGateOptions(env);
  const config = {
    concurrency: resolveSetting(concurrency, parsed.concurrency, LIMITS.concurrency),
    queueMax: resolveSetting(queueMax, parsed.queueMax, LIMITS.queueMax),
    queueWaitMs: resolveSetting(queueWaitMs, parsed.queueWaitMs, LIMITS.queueWaitMs),
  };
  // One bucket per site: calls for different sites never queue behind each other.
  const buckets = new Map();

  const bucketOf = (site) => {
    let bucket = buckets.get(site);
    if (!bucket) {
      bucket = { active: 0, waiting: [] };
      buckets.set(site, bucket);
    }
    return bucket;
  };

  const dropIfIdle = (site, bucket) => {
    if (buckets.get(site) !== bucket) return;
    if (bucket.active === 0 && bucket.waiting.length === 0) buckets.delete(site);
  };

  function release(site, bucket) {
    bucket.active -= 1;
    while (bucket.waiting.length > 0) {
      const next = bucket.waiting.shift();
      clearTimeout(next.timer);
      next.timer = null;
      // A queue entry can outlive its deadline while the event loop is busy:
      // the release microtask runs before the overdue timer callback. Expired
      // entries are refused here instead of being started late.
      if (Date.now() >= next.deadline) {
        next.reject(
          new SiteBusyError(
            `"${site}" is still busy after waiting ${config.queueWaitMs}ms`,
            { site, reason: "queue_timeout", queueWaitMs: config.queueWaitMs },
          ),
        );
        continue;
      }
      start(site, bucket, next);
      break;
    }
    dropIfIdle(site, bucket);
  }

  function start(site, bucket, entry) {
    bucket.active += 1;
    Promise.resolve()
      .then(entry.task)
      // Release before settling the caller's promise: by the time an awaited
      // gate.run() returns, its slot is already free for the next queued call.
      .then(
        (value) => {
          release(site, bucket);
          entry.resolve(value);
        },
        (error) => {
          release(site, bucket);
          entry.reject(error);
        },
      );
  }

  return {
    config: { ...config },
    run(site, task) {
      const bucket = bucketOf(site);
      if (bucket.active < config.concurrency) {
        return new Promise((resolve, reject) => start(site, bucket, { task, resolve, reject }));
      }
      if (bucket.waiting.length >= config.queueMax) {
        return Promise.reject(
          new SiteBusyError(
            `"${site}" already has ${bucket.active} running and ${bucket.waiting.length} queued call(s)`,
            { site, reason: "queue_full" },
          ),
        );
      }
      return new Promise((resolve, reject) => {
        const entry = { task, resolve, reject, timer: null, deadline: Date.now() + config.queueWaitMs };
        entry.timer = setTimeout(() => {
          const index = bucket.waiting.indexOf(entry);
          // A missing entry means it was already handed to start(); the caller
          // owns that promise from then on.
          if (index === -1) return;
          bucket.waiting.splice(index, 1);
          dropIfIdle(site, bucket);
          reject(
            new SiteBusyError(
              `"${site}" is still busy after waiting ${config.queueWaitMs}ms`,
              { site, reason: "queue_timeout", queueWaitMs: config.queueWaitMs },
            ),
          );
        }, config.queueWaitMs);
        bucket.waiting.push(entry);
      });
    },
    // Diagnostics only: sites without running or queued calls are omitted, so
    // the common case stays an empty object.
    snapshot() {
      const sites = {};
      for (const [site, bucket] of buckets) {
        if (bucket.active > 0 || bucket.waiting.length > 0) {
          sites[site] = { active: bucket.active, queued: bucket.waiting.length };
        }
      }
      return sites;
    },
  };
}
