import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createDefaultBridge } from "./bridge/factory.js";
import type { FigmaBridge } from "./bridge/types.js";
import type { ServerConfig } from "./config.js";
import { ConfirmationStore } from "./confirmations.js";
import { registerConnectionTool } from "./tools/connection.js";
import { registerDocumentTool } from "./tools/document.js";
import { registerNodeTool } from "./tools/node.js";
import { registerSelectionTool } from "./tools/selection.js";

export interface ServerOptions {
  bridge?: FigmaBridge;
  confirmations?: ConfirmationStore;
}

export function createMcpServer(
  config: ServerConfig,
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "mcp-fig",
    version: config.version,
  });
  const bridge = options.bridge ?? createDefaultBridge(config);
  const confirmations = options.confirmations ?? new ConfirmationStore();

  registerConnectionTool(server, config, bridge);
  registerDocumentTool(server, bridge);
  registerSelectionTool(server, bridge);
  registerNodeTool(server, bridge, confirmations);
  return server;
}
