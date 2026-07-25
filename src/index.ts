#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createDefaultBridge } from "./bridge/factory.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const bridge = createDefaultBridge(config);
  const server = createMcpServer(config, { bridge });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await bridge.close?.();
  };
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());

  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mcp-fig] Failed to start: ${message}`);
  process.exitCode = 1;
});
