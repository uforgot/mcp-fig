import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { FIGMA_NODE_TYPES, type FigmaBridge } from "../bridge/types.js";
import type { ConfirmationStore } from "../confirmations.js";
import { McpFigError } from "../errors.js";
import { handleToolCall, success } from "../tool-result.js";

const fileKey = z.string().min(1).optional();
const dryRun = z.boolean().default(false);
const nodeIds = z.array(z.string().min(1)).min(1).max(200);
const paints = z.array(z.record(z.string(), z.unknown()));
const nodeProps = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    text: z.string().optional(),
    fills: paints.optional(),
    strokes: paints.optional(),
  })
  .strict();
const nodePatch = nodeProps
  .extend({ name: z.string().min(1).optional() })
  .refine((patch) => Object.keys(patch).length > 0, "patch cannot be empty");

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), fileKey, nodeIds }).strict(),
  z
    .object({
      action: z.literal("create"),
      fileKey,
      parentId: z.string().min(1),
      nodeType: z.enum(FIGMA_NODE_TYPES),
      name: z.string().min(1).optional(),
      props: nodeProps.optional(),
      dryRun,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      fileKey,
      nodeIds,
      patch: nodePatch,
      dryRun,
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      fileKey,
      nodeIds,
      parentId: z.string().min(1).optional(),
      index: z.number().int().nonnegative().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      dryRun,
    })
    .strict()
    .refine(
      ({ parentId, x, y }) =>
        parentId !== undefined || x !== undefined || y !== undefined,
      "move requires parentId, x, or y",
    ),
  z
    .object({
      action: z.literal("resize"),
      fileKey,
      nodeIds,
      size: z
        .object({ width: z.number().positive(), height: z.number().positive() })
        .strict(),
      dryRun,
    })
    .strict(),
  z
    .object({
      action: z.literal("clone"),
      fileKey,
      nodeIds,
      parentId: z.string().min(1).optional(),
      offset: z
        .object({ x: z.number().finite(), y: z.number().finite() })
        .strict()
        .optional(),
      dryRun,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      fileKey,
      nodeIds,
      dryRun,
      confirm: z.string().uuid().optional(),
    })
    .strict(),
]);

function optionalFileKey(fileKeyValue: string | undefined) {
  return fileKeyValue ? { fileKey: fileKeyValue } : {};
}

export function registerNodeTool(
  server: McpServer,
  bridge: FigmaBridge,
  confirmations: ConfirmationStore,
): void {
  server.registerTool(
    "figma_node",
    {
      title: "Figma node",
      description:
        "Get, create, update, move, resize, clone, or explicitly delete Figma nodes without raw execution.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      handleToolCall("figma_node", input.action, async () => {
        const scope = optionalFileKey(input.fileKey);
        switch (input.action) {
          case "get":
            return success("figma_node", input.action, {
              nodes: await bridge.getNodes(input.nodeIds, input.fileKey),
            });
          case "create": {
            const nodes = await bridge.createNode({
              ...scope,
              parentId: input.parentId,
              nodeType: input.nodeType,
              ...(input.name ? { name: input.name } : {}),
              ...(input.props ? { props: input.props } : {}),
              dryRun: input.dryRun,
            });
            return success("figma_node", input.action, {
              nodes,
              dryRun: input.dryRun,
            });
          }
          case "update": {
            const nodes = await bridge.updateNodes({
              ...scope,
              nodeIds: input.nodeIds,
              patch: input.patch,
              dryRun: input.dryRun,
            });
            return success("figma_node", input.action, {
              nodes,
              dryRun: input.dryRun,
            });
          }
          case "move": {
            const nodes = await bridge.moveNodes({
              ...scope,
              nodeIds: input.nodeIds,
              ...(input.parentId ? { parentId: input.parentId } : {}),
              ...(input.index !== undefined ? { index: input.index } : {}),
              ...(input.x !== undefined ? { x: input.x } : {}),
              ...(input.y !== undefined ? { y: input.y } : {}),
              dryRun: input.dryRun,
            });
            return success("figma_node", input.action, {
              nodes,
              dryRun: input.dryRun,
            });
          }
          case "resize": {
            const nodes = await bridge.resizeNodes({
              ...scope,
              nodeIds: input.nodeIds,
              size: input.size,
              dryRun: input.dryRun,
            });
            return success("figma_node", input.action, {
              nodes,
              dryRun: input.dryRun,
            });
          }
          case "clone": {
            const nodes = await bridge.cloneNodes({
              ...scope,
              nodeIds: input.nodeIds,
              ...(input.parentId ? { parentId: input.parentId } : {}),
              ...(input.offset ? { offset: input.offset } : {}),
              dryRun: input.dryRun,
            });
            return success("figma_node", input.action, {
              nodes,
              dryRun: input.dryRun,
            });
          }
          case "delete": {
            const status = await bridge.status();
            const resolvedFileKey = input.fileKey ?? status.fileKey;
            if (!resolvedFileKey) {
              throw new McpFigError(
                "FILE_NOT_TARGETED",
                "No Figma file is targeted for deletion.",
              );
            }
            if (input.dryRun) {
              await bridge.getNodes(input.nodeIds, input.fileKey);
              return success("figma_node", input.action, {
                destructive: true,
                dryRun: true,
                fileKey: resolvedFileKey,
                nodeIds: input.nodeIds,
                confirmationToken: confirmations.issue(
                  "delete",
                  resolvedFileKey,
                  input.nodeIds,
                ),
              });
            }
            confirmations.consume(
              input.confirm,
              "delete",
              resolvedFileKey,
              input.nodeIds,
            );
            return success("figma_node", input.action, {
              deletedNodeIds: await bridge.deleteNodes({
                ...scope,
                nodeIds: input.nodeIds,
              }),
            });
          }
        }
      }),
  );
}
