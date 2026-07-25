import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge, TokenActionInput } from "../bridge/types.js";
import type { ConfirmationStore } from "../confirmations.js";
import { McpFigError } from "../errors.js";
import { handleToolCall, success } from "../tool-result.js";

const fileKey = z.string().min(1).optional();
const dryRun = z.boolean().default(false);
const alias = z
  .object({ type: z.literal("VARIABLE_ALIAS"), id: z.string().min(1) })
  .strict();
const variableValue = z.union([z.string(), z.number(), z.boolean(), alias]);
const operation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("bind"),
      nodeIds: z.array(z.string().min(1)).min(1).max(200),
      field: z.string().min(1),
      variableId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_value"),
      variableId: z.string().min(1),
      modeId: z.string().min(1),
      value: variableValue,
    })
    .strict(),
  z
    .object({
      op: z.literal("alias"),
      variableId: z.string().min(1),
      modeId: z.string().min(1),
      targetVariableId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("mode_add"),
      collectionId: z.string().min(1),
      modeId: z.string().min(1).optional(),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("mode_rename"),
      collectionId: z.string().min(1),
      modeId: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
]);

const inputSchema = z.union([
  z.object({ action: z.literal("inspect"), fileKey }).strict(),
  z
    .object({
      action: z.literal("apply"),
      operations: z.array(operation).min(1).max(200),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("collection_create"),
      name: z.string().min(1),
      initialModeName: z.string().min(1).optional(),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("collection_delete"),
      collectionId: z.string().min(1),
      dryRun,
      confirm: z.string().uuid().optional(),
      fileKey,
    })
    .strict(),
]);

export function registerTokensTool(
  server: McpServer,
  bridge: FigmaBridge,
  confirmations: ConfirmationStore,
): void {
  server.registerTool(
    "figma_tokens",
    {
      title: "Figma tokens",
      description:
        "Inspect variables and collections, apply values or aliases by mode, bind variables, and manage collections.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      const input = rawInput as TokenActionInput & { confirm?: string };
      return handleToolCall("figma_tokens", input.action, async () => {
        if (input.action === "collection_delete") {
          const status = await bridge.status();
          const resolvedFileKey = input.fileKey ?? status.fileKey;
          if (!resolvedFileKey) {
            throw new McpFigError(
              "FILE_NOT_TARGETED",
              "No Figma file is targeted.",
            );
          }
          if (input.dryRun) {
            const data = await bridge.tokens(input);
            return success("figma_tokens", input.action, {
              ...data,
              destructive: true,
              dryRun: true,
              confirmationToken: confirmations.issue(
                "tokens.collection_delete",
                resolvedFileKey,
                [input.collectionId],
              ),
            });
          }
          confirmations.consume(
            input.confirm,
            "tokens.collection_delete",
            resolvedFileKey,
            [input.collectionId],
          );
        }
        return success(
          "figma_tokens",
          input.action,
          await bridge.tokens(input),
        );
      });
    },
  );
}
