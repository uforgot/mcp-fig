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
    let failure: unknown;
    try {
      await server.close();
    } catch (error) {
      failure = error;
    }
    try {
      await bridge.close?.();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  };
  const requestShutdown = (): void => {
    void shutdown().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcp-fig] Failed to shut down: ${message}`);
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);

  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mcp-fig] Failed to start: ${message}`);
  process.exitCode = 1;
});
