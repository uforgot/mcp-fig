import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge, InstanceActionInput } from "../bridge/types.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";
import { writeControlSchema } from "./write-control.js";

const fileKey = z.string().min(1).optional();
const dryRun = z.boolean().default(false);
const properties = z.record(
  z.string().min(1),
  z.union([z.string(), z.boolean()]),
);

const inputSchema = z.union([
  z
    .object({
      action: z.literal("inspect"),
      instanceIds: z.array(z.string().min(1)).min(1).max(200),
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      ...writeControlSchema,
      componentId: z.string().min(1).optional(),
      componentKey: z.string().min(1).optional(),
      parentId: z.string().min(1),
      properties: properties.optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      dryRun,
      fileKey,
    })
    .strict()
    .refine(
      (input) =>
        (input.componentId === undefined) !==
        (input.componentKey === undefined),
      "create requires exactly one of componentId or componentKey",
    ),
  z
    .object({
      action: z.literal("swap"),
      ...writeControlSchema,
      instanceIds: z.array(z.string().min(1)).min(1).max(200),
      componentId: z.string().min(1).optional(),
      componentKey: z.string().min(1).optional(),
      preserveOverrides: z.boolean().default(true),
      dryRun,
      fileKey,
    })
    .strict()
    .refine(
      (input) =>
        (input.componentId === undefined) !==
        (input.componentKey === undefined),
      "swap requires exactly one of componentId or componentKey",
    ),
  z
    .object({
      action: z.literal("reset"),
      ...writeControlSchema,
      instanceIds: z.array(z.string().min(1)).min(1).max(200),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      ...writeControlSchema,
      instanceIds: z.array(z.string().min(1)).min(1).max(200),
      properties: properties.refine((value) => Object.keys(value).length > 0),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("slot_append"),
      ...writeControlSchema,
      instanceId: z.string().min(1),
      slotName: z.string().min(1),
      componentKey: z.string().min(1),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("slot_reset"),
      ...writeControlSchema,
      instanceId: z.string().min(1),
      slotName: z.string().min(1),
      dryRun,
      fileKey,
    })
    .strict(),
]);

export function registerInstanceTool(
  server: McpServer,
  bridge: FigmaBridge,
): void {
  server.registerTool(
    "figma_instance",
    {
      title: "Figma instance",
      description:
        "Inspect and create component instances, resolve display-name properties, swap components, reset overrides/defaults, and operate actual SlotNode content without raw execution.",
      inputSchema: exposeMcpInputSchema(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      const input = rawInput as InstanceActionInput;
      return handleToolCall("figma_instance", input.action, async () =>
        success("figma_instance", input.action, await bridge.instance(input)),
      );
    },
  );
}
