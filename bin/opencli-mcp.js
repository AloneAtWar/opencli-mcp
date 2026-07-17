#!/usr/bin/env node
import { startServer } from "../src/server.js";

startServer().catch((error) => {
  // MCP stdio reserves stdout for protocol frames.
  console.error(`[opencli-mcp] ${error.stack || error.message}`);
  process.exitCode = 1;
});
