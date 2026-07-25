import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaBridge, LayoutActionInput } from "../bridge/types.js";
import { LAYOUT_ISSUE_CODES } from "../bridge/types.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";
import { writeControlSchema } from "./write-control.js";

const fileKey = z.string().min(1).optional();
const dryRun = z.boolean().default(false);
const nodeIds = z.array(z.string().min(1)).min(1).max(200);
const padding = z.union([
  z.number().nonnegative(),
  z
    .object({
      top: z.number().nonnegative(),
      right: z.number().nonnegative(),
      bottom: z.number().nonnegative(),
      left: z.number().nonnegative(),
    })
    .strict(),
]);
const layout = z
  .object({
    layoutMode: z.enum(["HORIZONTAL", "VERTICAL"]),
    gap: z.number().nonnegative().optional(),
    itemSpacing: z.number().nonnegative().optional(),
    padding: padding.optional(),
    primaryAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"])
      .optional(),
    counterAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "BASELINE"])
      .optional(),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
    primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
  })
  .strict()
  .refine(
    (value) => value.gap === undefined || value.itemSpacing === undefined,
    {
      message: "Use gap or itemSpacing, not both.",
      path: ["gap"],
    },
  );
const sizing = z
  .object({
    horizontal: z.enum(["FIXED", "HUG", "FILL"]),
    vertical: z.enum(["FIXED", "HUG", "FILL"]),
    minWidth: z.number().nonnegative().optional(),
    maxWidth: z.number().nonnegative().optional(),
    minHeight: z.number().nonnegative().optional(),
    maxHeight: z.number().nonnegative().optional(),
    layoutAlign: z.enum(["INHERIT", "STRETCH"]).optional(),
  })
  .strict();
const constraints = z
  .object({
    horizontal: z.enum(["LEFT", "RIGHT", "CENTER", "LEFT_RIGHT", "SCALE"]),
    vertical: z.enum(["TOP", "BOTTOM", "CENTER", "TOP_BOTTOM", "SCALE"]),
  })
  .strict();
const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("apply"), nodeIds, layout }).strict(),
  z.object({ op: z.literal("sizing"), nodeIds, sizing }).strict(),
  z.object({ op: z.literal("constraints"), nodeIds, constraints }).strict(),
]);
const inputSchema = z.union([
  z.object({ action: z.literal("inspect"), nodeIds, fileKey }).strict(),
  z
    .object({
      action: z.literal("apply"),
      ...writeControlSchema,
      nodeIds,
      layout,
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("sizing"),
      ...writeControlSchema,
      nodeIds,
      sizing,
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("batch"),
      ...writeControlSchema,
      operations: z.array(operation).min(1).max(200),
      dryRun,
      fileKey,
    })
    .strict(),
  z.object({ action: z.literal("validate"), nodeIds, fileKey }).strict(),
  z
    .object({
      action: z.literal("repair"),
      ...writeControlSchema,
      nodeIds,
      issueCodes: z.array(z.enum(LAYOUT_ISSUE_CODES)).min(1).max(8),
      dryRun,
      fileKey,
    })
    .strict(),
]);

export function registerLayoutTool(
  server: McpServer,
  bridge: FigmaBridge,
): void {
  server.registerTool(
    "figma_layout",
    {
      title: "Figma Auto Layout",
      description:
        "Inspect and apply typed Auto Layout, sizing, and constraints with deterministic dependency-ordered batch previews.",
      inputSchema: exposeMcpInputSchema(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      const input = rawInput as LayoutActionInput;
      return handleToolCall("figma_layout", input.action, async () =>
        success("figma_layout", input.action, await bridge.layout(input)),
      );
    },
  );
}
