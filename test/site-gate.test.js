import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../src/server.js";
import { startHttpServer } from "../src/http-server.js";
import { createSiteGate, siteGateOptions } from "../src/site-gate.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

async function withClient(server, run) {
  const client = new Client({ name: "site-gate-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// The HTTP transport builds a server per request, so the gate it receives has to
// be shared per process. This reserves a real port for that listener.
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("same-site calls run one at a time by default", async () => {
  const gate = createSiteGate({ env: {} });
  const order = [];
  let releaseFirst;
  const first = gate.run("xiaohongshu", async () => {
    order.push("first:start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    order.push("first:end");
    return "one";
  });
  await tick();
  const second = gate.run("xiaohongshu", async () => {
    order.push("second:start");
    return "two";
  });
  await tick();

  assert.deepEqual(order, ["first:start"], "the second call may not start while the first is running");
  releaseFirst();
  assert.equal(await first, "one");
  assert.equal(await second, "two");
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  assert.deepEqual(gate.snapshot(), {}, "idle sites are dropped from the snapshot");
});

test("different sites never queue behind each other", async () => {
  const gate = createSiteGate({ env: {} });
  let releaseA;
  const a = gate.run("site-a", async () => {
    await new Promise((resolve) => {
      releaseA = resolve;
    });
    return "a";
  });
  await tick();
  const b = gate.run("site-b", async () => "b");

  assert.equal(await b, "b", "site-b must not wait for site-a");
  releaseA();
  assert.equal(await a, "a");
});

test("a concurrency above one lets the same site run in parallel", async () => {
  const gate = createSiteGate({ env: {}, concurrency: 2 });
  let active = 0;
  let peak = 0;
  const task = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  };

  await Promise.all([gate.run("s", task), gate.run("s", task)]);
  assert.equal(peak, 2);
});

test("a full queue rejects immediately with SITE_BUSY and leaves the queued call intact", async () => {
  const gate = createSiteGate({ env: {}, concurrency: 1, queueMax: 1, queueWaitMs: 5_000 });
  let releaseRunning;
  const running = gate.run("s", async () => {
    await new Promise((resolve) => {
      releaseRunning = resolve;
    });
    return "running";
  });
  await tick();
  const queued = gate.run("s", async () => "queued");
  await tick();
  assert.deepEqual(gate.snapshot(), { s: { active: 1, queued: 1 } });

  await assert.rejects(
    () => gate.run("s", async () => "third"),
    (error) => {
      assert.equal(error.name, "SiteBusyError");
      assert.equal(error.mcpError.code, "SITE_BUSY");
      assert.equal(error.mcpError.reason, "queue_full");
      assert.equal(error.mcpError.site, "s");
      assert.match(error.mcpError.hint, /do not retry in parallel/);
      return true;
    },
  );

  releaseRunning();
  assert.equal(await running, "running");
  assert.equal(await queued, "queued");
});

test("a queued call that waits too long is rejected and never runs", async () => {
  const gate = createSiteGate({ env: {}, concurrency: 1, queueMax: 2, queueWaitMs: 20 });
  let releaseRunning;
  let ran = false;
  const running = gate.run("s", async () => {
    await new Promise((resolve) => {
      releaseRunning = resolve;
    });
  });
  await tick();
  const queued = gate.run("s", async () => {
    ran = true;
  });

  await assert.rejects(queued, (error) => {
    assert.equal(error.mcpError.code, "SITE_BUSY");
    assert.equal(error.mcpError.reason, "queue_timeout");
    assert.equal(error.mcpError.queue_wait_ms, 20);
    return true;
  });
  assert.deepEqual(gate.snapshot(), { s: { active: 1, queued: 0 } });

  releaseRunning();
  await running;
  await tick();
  assert.equal(ran, false, "an expired queued call must not run after the slot frees up");
  assert.deepEqual(gate.snapshot(), {});
});

test("a failing task still releases its slot", async () => {
  const gate = createSiteGate({ env: {} });
  await assert.rejects(() => gate.run("s", async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(await gate.run("s", async () => "after"), "after");
  assert.deepEqual(gate.snapshot(), {});
});

test("site gate settings come from the environment with safe fallbacks", () => {
  assert.deepEqual(siteGateOptions({}), { concurrency: 1, queueMax: 8, queueWaitMs: 30_000 });
  assert.deepEqual(
    siteGateOptions({
      OPENCLI_MCP_SITE_CONCURRENCY: "3",
      OPENCLI_MCP_SITE_QUEUE_MAX: "2",
      OPENCLI_MCP_SITE_QUEUE_WAIT_MS: "500",
    }),
    { concurrency: 3, queueMax: 2, queueWaitMs: 500 },
  );
  assert.deepEqual(
    siteGateOptions({
      OPENCLI_MCP_SITE_CONCURRENCY: "0",
      OPENCLI_MCP_SITE_QUEUE_MAX: "nope",
      OPENCLI_MCP_SITE_QUEUE_WAIT_MS: "-5",
    }),
    { concurrency: 1, queueMax: 8, queueWaitMs: 30_000 },
  );
});

test("opencli_run answers a saturated site with SITE_BUSY instead of stacking calls", async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  // Only the first command blocks; the "other" site must return immediately.
  const runOpenCli = async (args) => {
    if (args[1] === "slow") {
      firstStarted();
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    return { data: { ok: true } };
  };
  const env = {
    OPENCLI_MCP_SITE_CONCURRENCY: "1",
    OPENCLI_MCP_SITE_QUEUE_MAX: "1",
    OPENCLI_MCP_SITE_QUEUE_WAIT_MS: "5000",
  };
  const gate = createSiteGate({ env });
  const server = createServer({ runOpenCli, siteGate: gate, runnerOptions: { env } });

  await withClient(server, async (client) => {
    const first = client.callTool({ name: "opencli_run", arguments: { site: "demo", command: "slow" } });
    await started;
    const second = client.callTool({ name: "opencli_run", arguments: { site: "demo", command: "queued" } });
    await waitFor(() => gate.snapshot().demo?.queued === 1, "the second call to be queued");

    const third = await client.callTool({ name: "opencli_run", arguments: { site: "demo", command: "rejected" } });
    assert.equal(third.isError, true);
    assert.equal(third.structuredContent.error.code, "SITE_BUSY");
    assert.equal(third.structuredContent.error.reason, "queue_full");
    assert.equal(third.structuredContent.error.site, "demo");

    const otherSite = await client.callTool({ name: "opencli_run", arguments: { site: "other", command: "fast" } });
    assert.equal(otherSite.isError, undefined, "a different site must not be blocked by the saturated one");

    releaseFirst();
    await first;
    await second;
  });
});

test("opencli_status reports the effective site gate", async () => {
  const server = createServer({
    runOpenCli: async () => ({ data: "1.8.8" }),
    runnerOptions: { env: { OPENCLI_MCP_SITE_CONCURRENCY: "2", OPENCLI_MCP_SITE_QUEUE_MAX: "4" } },
  });

  await withClient(server, async (client) => {
    const status = await client.callTool({ name: "opencli_status", arguments: { doctor: false } });
    assert.equal(status.structuredContent.site_gate.concurrency, 2);
    assert.equal(status.structuredContent.site_gate.queue_max, 4);
    assert.equal(status.structuredContent.site_gate.queue_wait_ms, 30_000);
    assert.deepEqual(status.structuredContent.site_gate.busy, {});
  });
});

test("explicit settings are range-checked exactly like their environment variables", () => {
  const defaults = { concurrency: 1, queueMax: 8, queueWaitMs: 30_000 };
  assert.deepEqual(createSiteGate({ env: {}, concurrency: 0 }).config, defaults);
  assert.deepEqual(createSiteGate({ env: {}, concurrency: 1.5 }).config, defaults);
  assert.deepEqual(createSiteGate({ env: {}, queueMax: 0 }).config, defaults);
  assert.deepEqual(createSiteGate({ env: {}, queueWaitMs: 2_147_483_648 }).config, defaults);
  assert.deepEqual(
    createSiteGate({ env: { OPENCLI_MCP_SITE_QUEUE_WAIT_MS: "2147483648" } }).config.queueWaitMs,
    30_000,
    "a timeout Node would clamp to 1ms must not be accepted",
  );
  assert.equal(createSiteGate({ env: {}, concurrency: 3 }).config.concurrency, 3);
});

test("an entry that expires while the loop is blocked is refused, not started late", async () => {
  const gate = createSiteGate({ env: {}, concurrency: 1, queueMax: 2, queueWaitMs: 5 });
  let releaseRunning;
  let ran = false;
  const running = gate.run("s", async () => {
    await new Promise((resolve) => {
      releaseRunning = resolve;
    });
  });
  await tick();
  const queued = gate.run("s", async () => {
    ran = true;
  });
  await tick();

  // Block past the deadline: the release microtask then runs before the overdue
  // timer callback, which is exactly the race the deadline check covers.
  const end = Date.now() + 30;
  while (Date.now() < end) { /* busy wait */ }
  releaseRunning();

  await assert.rejects(queued, (error) => {
    assert.equal(error.mcpError.reason, "queue_timeout");
    return true;
  });
  await running;
  assert.equal(ran, false);
});

test("a third call waits when the site allows two at a time", async () => {
  const gate = createSiteGate({ env: {}, concurrency: 2, queueMax: 4 });
  const releases = [];
  const hold = () => new Promise((resolve) => {
    releases.push(resolve);
  });
  const a = gate.run("s", hold);
  const b = gate.run("s", hold);
  await tick();
  assert.equal(releases.length, 2);

  const c = gate.run("s", async () => "c");
  await tick();
  assert.deepEqual(gate.snapshot(), { s: { active: 2, queued: 1 } });
  releases[0]();
  releases[1]();
  await Promise.all([a, b]);
  assert.equal(await c, "c");
});

test("a queued call still runs after the call ahead of it fails", async () => {
  const gate = createSiteGate({ env: {} });
  let failFirst;
  const first = gate.run("s", () => new Promise((_resolve, reject) => {
    failFirst = reject;
  }));
  await tick();
  const second = gate.run("s", async () => "second");
  await tick();
  assert.deepEqual(gate.snapshot(), { s: { active: 1, queued: 1 } });

  failFirst(new Error("boom"));
  await assert.rejects(first, /boom/);
  assert.equal(await second, "second");
  assert.deepEqual(gate.snapshot(), {});
});

test("the HTTP transport shares one gate across stateless requests", async () => {
  const env = {
    OPENCLI_MCP_SITE_CONCURRENCY: "1",
    OPENCLI_MCP_SITE_QUEUE_MAX: "1",
    OPENCLI_MCP_SITE_QUEUE_WAIT_MS: "5000",
  };
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const runOpenCli = async (args) => {
    if (args[1] === "slow") {
      firstStarted();
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    return { data: { ok: true } };
  };
  const gate = createSiteGate({ env });
  const port = await freePort();
  const httpServer = startHttpServer({ host: "127.0.0.1", port, siteGate: gate, runOpenCli, runnerOptions: { env } });
  const client = new Client({ name: "http-site-gate-test", version: "1.0" });

  try {
    await once(httpServer, "listening");
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    const first = client.callTool({ name: "opencli_run", arguments: { site: "demo", command: "slow" } });
    await started;
    const second = client.callTool({ name: "opencli_run", arguments: { site: "demo", command: "queued" } });
    await waitFor(() => gate.snapshot().demo?.queued === 1, "the second HTTP request to be queued");

    const third = await client.callTool({ name: "opencli_run", arguments: { site: "demo", command: "rejected" } });
    assert.equal(third.isError, true, "a per-request gate would have let this through");
    assert.equal(third.structuredContent.error.code, "SITE_BUSY");
    assert.equal(third.structuredContent.error.reason, "queue_full");

    releaseFirst();
    await first;
    await second;
  } finally {
    await client.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
