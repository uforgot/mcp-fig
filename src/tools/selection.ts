import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge } from "../bridge/types.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";

const fileKey = z.string().min(1).optional();
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), fileKey }).strict(),
  z.object({ action: z.literal("inspect"), fileKey }).strict(),
]);

export function registerSelectionTool(
  server: McpServer,
  bridge: FigmaBridge,
): void {
  server.registerTool(
    "figma_selection",
    {
      title: "Figma selection",
      description: "Read the current Desktop Plugin selection and its nodes.",
      inputSchema: exposeMcpInputSchema(inputSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ action, fileKey: requestedFileKey }) =>
      handleToolCall("figma_selection", action, async () => {
        const nodeIds = await bridge.getSelection(requestedFileKey);
        if (action === "get") {
          return success("figma_selection", action, { nodeIds });
        }
        return success("figma_selection", action, {
          nodeIds,
          nodes:
            nodeIds.length > 0
              ? await bridge.getNodes(nodeIds, requestedFileKey)
              : [],
        });
      }),
  );
}
