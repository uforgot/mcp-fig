import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge } from "../bridge/types.js";
import type { ServerConfig } from "../config.js";
import { handleToolCall, success } from "../tool-result.js";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("list_files") }).strict(),
  z
    .object({ action: z.literal("target"), fileKey: z.string().min(1) })
    .strict(),
  z.object({ action: z.literal("reconnect") }).strict(),
  z.object({ action: z.literal("capabilities") }).strict(),
]);

const REGISTERED_CORE_TOOLS = [
  "figma_connection",
  "figma_document",
  "figma_selection",
  "figma_node",
  "figma_layout",
  "figma_component",
  "figma_instance",
  "figma_tokens",
] as const;

export function registerConnectionTool(
  server: McpServer,
  config: ServerConfig,
  bridge: FigmaBridge,
): void {
  server.registerTool(
    "figma_connection",
    {
      title: "Figma connection",
      description:
        "Inspect connection health, target a file, reconnect, or discover enabled MCP Fig capabilities.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      handleToolCall("figma_connection", input.action, async () => {
        const { action } = input;
        if (action === "list_files") {
          return success("figma_connection", action, {
            files: await bridge.listFiles(),
          });
        }
        if (action === "target") {
          return success("figma_connection", action, {
            status: await bridge.targetFile(input.fileKey),
          });
        }
        if (action === "reconnect") {
          return success("figma_connection", action, {
            status: await bridge.reconnect(),
          });
        }

        const status = await bridge.status();
        if (action === "status") {
          return success("figma_connection", action, {
            ...status,
            bridge:
              status.mode === "disconnected" ? "not-configured" : status.mode,
            serverVersion: config.version,
          });
        }

        return success("figma_connection", action, {
          profiles: config.profiles,
          registeredTools: REGISTERED_CORE_TOOLS,
          dryRun: true,
          rawExecuteDryRun: false,
          bridge: status,
        });
      }),
  );
}
