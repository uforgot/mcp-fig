import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { saveNodeExports } from "../artifacts/node-export.js";
import { FIGMA_NODE_TYPES, type FigmaBridge } from "../bridge/types.js";
import type { ConfirmationStore } from "../confirmations.js";
import { McpFigError } from "../errors.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";
import { writeControlSchema } from "./write-control.js";

const fileKey = z.string().min(1).optional();
const dryRun = z.boolean().default(false);
const nodeIds = z.array(z.string().min(1)).min(1).max(200);
const blendMode = z.enum([
  "PASS_THROUGH",
  "NORMAL",
  "DARKEN",
  "MULTIPLY",
  "LINEAR_BURN",
  "COLOR_BURN",
  "LIGHTEN",
  "SCREEN",
  "LINEAR_DODGE",
  "COLOR_DODGE",
  "OVERLAY",
  "SOFT_LIGHT",
  "HARD_LIGHT",
  "DIFFERENCE",
  "EXCLUSION",
  "HUE",
  "SATURATION",
  "COLOR",
  "LUMINOSITY",
]);
const rgb = z
  .object({
    r: z.number().finite().min(0).max(1),
    g: z.number().finite().min(0).max(1),
    b: z.number().finite().min(0).max(1),
  })
  .strict();
const rgba = rgb.extend({ a: z.number().finite().min(0).max(1) }).strict();
const paintShared = {
  opacity: z.number().finite().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  blendMode: blendMode.optional(),
};
const paints = z.array(
  z.union([
    z
      .object({
        type: z.literal("SOLID"),
        color: rgb,
        ...paintShared,
      })
      .strict(),
    z
      .object({
        type: z.enum([
          "GRADIENT_LINEAR",
          "GRADIENT_RADIAL",
          "GRADIENT_ANGULAR",
          "GRADIENT_DIAMOND",
        ]),
        gradientTransform: z.tuple([
          z.tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ]),
          z.tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ]),
        ]),
        gradientStops: z
          .array(
            z
              .object({
                position: z.number().finite().min(0).max(1),
                color: rgba,
              })
              .strict(),
          )
          .min(2)
          .max(64),
        ...paintShared,
      })
      .strict(),
  ]),
);
const effects = z.array(
  z.union([
    z
      .object({
        type: z.enum(["DROP_SHADOW", "INNER_SHADOW"]),
        color: rgba,
        offset: z
          .object({ x: z.number().finite(), y: z.number().finite() })
          .strict(),
        radius: z.number().finite().nonnegative(),
        spread: z.number().finite().optional(),
        visible: z.boolean().default(true),
        blendMode: blendMode.default("NORMAL"),
      })
      .strict(),
    z
      .object({
        type: z.enum(["LAYER_BLUR", "BACKGROUND_BLUR"]),
        radius: z.number().finite().nonnegative(),
        visible: z.boolean().default(true),
        blurType: z.literal("NORMAL").default("NORMAL"),
      })
      .strict(),
  ]),
);
const constraints = z
  .object({
    horizontal: z.enum(["LEFT", "RIGHT", "CENTER", "LEFT_RIGHT", "SCALE"]),
    vertical: z.enum(["TOP", "BOTTOM", "CENTER", "TOP_BOTTOM", "SCALE"]),
  })
  .strict();
const fontName = z
  .object({
    family: z.string().min(1),
    style: z.string().min(1),
  })
  .strict();
const lineHeight = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("AUTO") }).strict(),
  z
    .object({
      unit: z.enum(["PIXELS", "PERCENT"]),
      value: z.number().positive(),
    })
    .strict(),
]);
const letterSpacing = z
  .object({
    unit: z.enum(["PIXELS", "PERCENT"]),
    value: z.number().finite(),
  })
  .strict();
const nodeProps = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    text: z.string().optional(),
    fontName: fontName.optional(),
    fontSize: z.number().finite().min(1).optional(),
    lineHeight: lineHeight.optional(),
    letterSpacing: letterSpacing.optional(),
    textAlignHorizontal: z
      .enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])
      .optional(),
    textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
    fills: paints.optional(),
    strokes: paints.optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    cornerRadius: z.number().finite().nonnegative().optional(),
    effects: effects.optional(),
    blendMode: blendMode.optional(),
    constraints: constraints.optional(),
  })
  .strict();
const nodePatch = nodeProps
  .extend({ name: z.string().min(1).optional() })
  .refine((patch) => Object.keys(patch).length > 0, "patch cannot be empty");

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), fileKey, nodeIds }).strict(),
  z
    .object({
      action: z.literal("query"),
      fileKey,
      rootId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      nameMatch: z.enum(["exact", "contains"]).default("exact"),
      caseSensitive: z.boolean().default(true),
      nodeType: z.enum(FIGMA_NODE_TYPES).optional(),
      path: z.array(z.string().min(1)).min(1).max(20).optional(),
      maxDepth: z.number().int().min(0).max(20).default(8),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict()
    .refine(
      ({ name, nodeType, path }) =>
        name !== undefined || nodeType !== undefined || path !== undefined,
      "query requires name, nodeType, or path",
    ),
  z
    .object({
      action: z.literal("export"),
      fileKey,
      nodeIds,
      format: z.enum(["PNG", "JPG", "SVG", "PDF"]).default("PNG"),
      scale: z.number().finite().min(0.1).max(4).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      fileKey,
      parentId: z.string().min(1),
      nodeType: z.enum(FIGMA_NODE_TYPES),
      name: z.string().min(1).optional(),
      props: nodeProps.optional(),
      dryRun,
      ...writeControlSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      fileKey,
      nodeIds,
      patch: nodePatch,
      dryRun,
      ...writeControlSchema,
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
      ...writeControlSchema,
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
      ...writeControlSchema,
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
      ...writeControlSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      fileKey,
      nodeIds,
      dryRun,
      confirm: z.string().uuid().optional(),
      ...writeControlSchema,
    })
    .strict(),
]);

function optionalFileKey(fileKeyValue: string | undefined) {
  return fileKeyValue ? { fileKey: fileKeyValue } : {};
}

function writeControl(input: {
  expectedRevision?: string | undefined;
  idempotencyKey?: string | undefined;
}) {
  return {
    ...(input.expectedRevision
      ? { expectedRevision: input.expectedRevision }
      : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
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
        "Get/query, export, create, update, move, resize, clone, or explicitly delete Figma nodes without raw execution. Query traversal is depth/limit bounded. Exported files are saved under ~/.mcp-fig/exports.",
      inputSchema: exposeMcpInputSchema(inputSchema),
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
          case "query":
            return success("figma_node", input.action, {
              ...(await bridge.queryNodes({
                ...scope,
                ...(input.rootId ? { rootId: input.rootId } : {}),
                ...(input.name ? { name: input.name } : {}),
                nameMatch: input.nameMatch,
                caseSensitive: input.caseSensitive,
                ...(input.nodeType ? { nodeType: input.nodeType } : {}),
                ...(input.path ? { path: input.path } : {}),
                maxDepth: input.maxDepth,
                limit: input.limit,
              })),
            });
          case "export": {
            const raster = input.format === "PNG" || input.format === "JPG";
            if (!raster && input.scale !== undefined) {
              throw new McpFigError(
                "INVALID_ARGUMENT",
                `${input.format} export does not accept scale.`,
              );
            }
            const exports = await bridge.exportNodes({
              ...scope,
              nodeIds: input.nodeIds,
              format: input.format,
              ...(raster ? { scale: input.scale ?? 1 } : {}),
            });
            return success("figma_node", input.action, {
              artifacts: await saveNodeExports(exports),
            });
          }
          case "create": {
            const nodes = await bridge.createNode({
              ...scope,
              ...writeControl(input),
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
              ...writeControl(input),
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
              ...writeControl(input),
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
              ...writeControl(input),
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
              ...writeControl(input),
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
                ...writeControl(input),
                nodeIds: input.nodeIds,
              }),
            });
          }
        }
      }),
  );
}
