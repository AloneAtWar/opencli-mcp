#!/usr/bin/env node
import { startHttpServer } from "../src/http-server.js";

const server = startHttpServer();
const shutdown = (signal) => {
  console.error(`[opencli-mcp-http] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
