import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge, InstanceActionInput } from "../bridge/types.js";
import { handleToolCall, success } from "../tool-result.js";

const fileKey = z.string().min(1).optional();
const dryRun = z.boolean().default(false);
const properties = z.record(
  z.string().min(1),
  z.union([z.string(), z.boolean()]),
);

const inputSchema = z.union([
  z
    .object({
      action: z.literal("create"),
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
        input.componentId !== undefined || input.componentKey !== undefined,
      "create requires componentId or componentKey",
    ),
  z
    .object({
      action: z.literal("update"),
      instanceIds: z.array(z.string().min(1)).min(1).max(200),
      properties: properties.refine((value) => Object.keys(value).length > 0),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("slot_append"),
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
        "Create component instances, update typed properties, and manage component slots without raw execution.",
      inputSchema,
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
