import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ServerConfig } from "./config.js";

const connectionInputSchema = z
  .object({
    action: z.enum(["status", "capabilities"]),
  })
  .strict();

interface ResultEnvelope {
  ok: true;
  tool: "figma_connection";
  action: "status" | "capabilities";
  data: Record<string, unknown>;
  warnings: string[];
  traceId: string;
}

function asToolResult(payload: ResultEnvelope) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function registerConnectionTool(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "figma_connection",
    {
      title: "Figma connection",
      description:
        "Inspect MCP Fig health and discover the capabilities enabled for this server process.",
      inputSchema: connectionInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ action }) => {
      const common = {
        ok: true as const,
        tool: "figma_connection" as const,
        action,
        warnings: [],
        traceId: randomUUID(),
      };

      if (action === "status") {
        return asToolResult({
          ...common,
          data: {
            connected: false,
            bridge: "not-configured",
            serverVersion: config.version,
          },
        });
      }

      return asToolResult({
        ...common,
        data: {
          profiles: config.profiles,
          registeredTools: ["figma_connection"],
          dryRun: true,
          rawExecuteDryRun: false,
          bridge: {
            connected: false,
            mode: "not-configured",
          },
        },
      });
    },
  );
}

export function createMcpServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: "mcp-fig",
    version: config.version,
  });

  registerConnectionTool(server, config);
  return server;
}
