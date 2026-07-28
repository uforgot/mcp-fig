import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge } from "../bridge/types.js";
import { McpFigError } from "../errors.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("comments"),
      fileKey: z.string().min(1).optional(),
      nodeIds: z.array(z.string().min(1)).min(1).max(200).optional(),
      resolved: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
]);

export function registerCollaborationTool(
  server: McpServer,
  bridge: FigmaBridge,
): void {
  server.registerTool(
    "figma_collaboration",
    {
      title: "Figma collaboration",
      description:
        "Read Figma file comments through the optional collaboration profile. Supports node, resolution-state, and result-limit filters.",
      inputSchema: exposeMcpInputSchema(inputSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ action, fileKey, nodeIds, resolved, limit }) =>
      handleToolCall("figma_collaboration", action, async () => {
        if (!bridge.getComments) {
          throw new McpFigError(
            "UNSUPPORTED_BY_BRIDGE",
            "Figma comments are unavailable on the active bridge.",
          );
        }
        const allComments = await bridge.getComments(fileKey);
        const nodeIdSet = nodeIds ? new Set(nodeIds) : undefined;
        const comments = allComments
          .filter(
            (comment) =>
              !nodeIdSet ||
              Boolean(comment.nodeId && nodeIdSet.has(comment.nodeId)),
          )
          .filter(
            (comment) =>
              resolved === undefined ||
              (comment.resolvedAt !== null) === resolved,
          )
          .slice(0, limit);
        return success("figma_collaboration", action, {
          comments,
          count: comments.length,
          total: allComments.length,
          source: "rest",
        });
      }),
  );
}
