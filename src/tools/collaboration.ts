import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge } from "../bridge/types.js";
import { McpFigError } from "../errors.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";

const messageSchema = z.string().trim().min(1).max(10_000);
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
  z
    .object({
      action: z.literal("post"),
      fileKey: z.string().min(1),
      message: messageSchema,
      nodeId: z.string().min(1),
      nodeOffset: z
        .object({ x: z.number().finite(), y: z.number().finite() })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reply"),
      fileKey: z.string().min(1),
      message: messageSchema,
      commentId: z.string().min(1),
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
        "Read, post, and reply to Figma file comments through the optional collaboration profile. Existing comment text cannot be edited because Figma provides no edit endpoint.",
      inputSchema: exposeMcpInputSchema(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      handleToolCall("figma_collaboration", input.action, async () => {
        if (input.action === "comments") {
          if (!bridge.getComments) {
            throw new McpFigError(
              "UNSUPPORTED_BY_BRIDGE",
              "Figma comments are unavailable on the active bridge.",
            );
          }
          const allComments = await bridge.getComments(input.fileKey);
          const nodeIdSet = input.nodeIds ? new Set(input.nodeIds) : undefined;
          const comments = allComments
            .filter(
              (comment) =>
                !nodeIdSet ||
                Boolean(comment.nodeId && nodeIdSet.has(comment.nodeId)),
            )
            .filter(
              (comment) =>
                input.resolved === undefined ||
                (comment.resolvedAt !== null) === input.resolved,
            )
            .slice(0, input.limit);
          return success("figma_collaboration", input.action, {
            comments,
            count: comments.length,
            total: allComments.length,
            source: "rest",
          });
        }

        if (!bridge.postComment) {
          throw new McpFigError(
            "UNSUPPORTED_BY_BRIDGE",
            "Posting Figma comments is unavailable on the active bridge.",
          );
        }
        const comment = await bridge.postComment(input);
        return success("figma_collaboration", input.action, {
          comment,
          source: "rest",
          retrySafe: false,
        });
      }),
  );
}
