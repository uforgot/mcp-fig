import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ComponentActionInput, FigmaBridge } from "../bridge/types.js";
import type { ProfileName } from "../config.js";
import type { ConfirmationStore } from "../confirmations.js";
import { McpFigError } from "../errors.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";
import { writeControlSchema } from "./write-control.js";

const fileKey = z.string().min(1).optional();
const dryRun = z.boolean().default(false);
const slotSettings = z
  .object({
    stretchChildOnInsert: z.boolean().optional(),
    displayEmptyByDefault: z.boolean().optional(),
    minChildren: z.number().int().nonnegative().nullable().optional(),
    maxChildren: z.number().int().nonnegative().nullable().optional(),
    allowPreferredValuesOnly: z.boolean().optional(),
  })
  .strict()
  .refine(
    (settings) =>
      settings.minChildren == null ||
      settings.maxChildren == null ||
      settings.minChildren <= settings.maxChildren,
    "slot minChildren must not exceed maxChildren",
  );
const property = z
  .object({
    type: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"]),
    defaultValue: z.union([z.string(), z.boolean()]),
    options: z.array(z.string()).min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    slotSettings: slotSettings.optional(),
  })
  .strict();

const componentAxes = z
  .record(
    z.string().min(1),
    z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .refine(
        (values) => new Set(values).size === values.length,
        "axis values must be unique",
      ),
  )
  .superRefine((axes, context) => {
    const entries = Object.entries(axes);
    const combinations = entries.reduce(
      (count, [, values]) => count * values.length,
      1,
    );
    if (entries.length < 1 || entries.length > 8 || combinations > 100) {
      context.addIssue({
        code: "custom",
        message: "axes require 1 to 8 axes and at most 100 variants",
      });
    }
  });

const coreSchemas = [
  z
    .object({
      action: z.literal("search"),
      query: z.string().optional(),
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("inspect"),
      componentId: z.string().min(1).optional(),
      componentKey: z.string().min(1).optional(),
      fileKey,
    })
    .strict()
    .refine(
      (input) =>
        (input.componentId === undefined) !==
        (input.componentKey === undefined),
      "inspect requires exactly one of componentId or componentKey",
    ),
  z
    .object({
      action: z.literal("create_set"),
      ...writeControlSchema,
      parentId: z.string().min(1),
      name: z.string().min(1),
      axes: componentAxes,
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("arrange_set"),
      ...writeControlSchema,
      componentSetId: z.string().min(1),
      columns: z.number().int().positive().optional(),
      gap: z.number().nonnegative().optional(),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("set_description"),
      ...writeControlSchema,
      componentId: z.string().min(1),
      description: z.string(),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("property_add"),
      ...writeControlSchema,
      componentId: z.string().min(1),
      propertyName: z.string().min(1),
      property,
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("property_update"),
      ...writeControlSchema,
      componentId: z.string().min(1),
      propertyName: z.string().min(1),
      patch: property
        .partial()
        .refine((value) => Object.keys(value).length > 0),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("property_delete"),
      ...writeControlSchema,
      componentId: z.string().min(1),
      propertyName: z.string().min(1),
      dryRun,
      confirm: z.string().uuid().optional(),
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("slots"),
      componentId: z.string().min(1),
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("slot_create"),
      ...writeControlSchema,
      componentId: z.string().min(1),
      slotName: z.string().min(1),
      allowedComponentKeys: z.array(z.string().min(1)).max(100).optional(),
      description: z.string().max(500).optional(),
      slotSettings: slotSettings.optional(),
      dryRun,
      fileKey,
    })
    .strict(),
] as const;

const librarySchemas = [
  z
    .object({
      action: z.literal("library_search"),
      query: z.string().optional(),
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("library_inspect"),
      componentKey: z.string().min(1),
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("library_import"),
      ...writeControlSchema,
      componentKey: z.string().min(1),
      kind: z.enum(["COMPONENT", "COMPONENT_SET"]),
      dryRun,
      fileKey,
    })
    .strict(),
] as const;

export function registerComponentTool(
  server: McpServer,
  bridge: FigmaBridge,
  profiles: ProfileName[],
  confirmations: ConfirmationStore,
): void {
  const schemas = profiles.includes("libraries")
    ? [...coreSchemas, ...librarySchemas]
    : [...coreSchemas];
  const inputSchema = z.union(
    schemas as [
      (typeof schemas)[number],
      (typeof schemas)[number],
      ...(typeof schemas)[number][],
    ],
  );

  const knownLibraryComponents = new Map<string, Record<string, unknown>>();

  server.registerTool(
    "figma_component",
    {
      title: "Figma component",
      description:
        "Search, inspect, create, arrange, and manage local components; library actions are profile-gated and key-addressed.",
      inputSchema: exposeMcpInputSchema(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      const input = rawInput as ComponentActionInput & {
        confirm?: string;
        dryRun?: boolean;
      };
      return handleToolCall("figma_component", input.action, async () => {
        if (input.action === "property_delete") {
          const status = await bridge.status();
          const resolvedFileKey = input.fileKey ?? status.fileKey;
          if (!resolvedFileKey) {
            throw new McpFigError(
              "FILE_NOT_TARGETED",
              "No Figma file is targeted.",
            );
          }
          const target = `${input.componentId}:${input.propertyName}`;
          if (input.dryRun) {
            const data = await bridge.component(input);
            return success("figma_component", input.action, {
              ...data,
              destructive: true,
              dryRun: true,
              confirmationToken: confirmations.issue(
                "component.property_delete",
                resolvedFileKey,
                [target],
              ),
            });
          }
          confirmations.consume(
            input.confirm,
            "component.property_delete",
            resolvedFileKey,
            [target],
          );
        }
        if (input.action === "inspect") {
          const inspected = await bridge.component(input);
          const component = inspected.component as
            | { source?: string; kind?: string; key?: string }
            | undefined;
          if (component?.source === "library" && component.key)
            knownLibraryComponents.set(component.key, inspected);
          return success("figma_component", input.action, inspected);
        }
        if (input.action === "library_import" && !input.dryRun) {
          const known = knownLibraryComponents.get(input.componentKey);
          const knownComponent = known?.component as
            | { source?: string; kind?: string }
            | undefined;
          if (
            knownComponent?.source === "library" &&
            knownComponent.kind === input.kind
          )
            return success("figma_component", input.action, {
              alreadyImported: true,
              imported: known?.component,
              node: known?.node,
            });
          try {
            const existing = await bridge.component({
              action: "inspect",
              componentKey: input.componentKey,
              ...(input.fileKey ? { fileKey: input.fileKey } : {}),
            });
            const component = existing.component as
              | { source?: string; kind?: string }
              | undefined;
            if (
              component?.source === "library" &&
              component.kind === input.kind
            ) {
              return success("figma_component", input.action, {
                alreadyImported: true,
                imported: existing.component,
                node: existing.node,
              });
            }
          } catch (error) {
            if (
              !(error instanceof McpFigError) ||
              error.code !== "NODE_NOT_FOUND"
            )
              throw error;
          }
          const imported = await bridge.component(input);
          const importedComponent = imported.imported as
            | { source?: string; kind?: string; key?: string }
            | undefined;
          if (importedComponent?.source === "library" && importedComponent.key)
            knownLibraryComponents.set(importedComponent.key, {
              component: importedComponent,
              node: imported.node,
            });
          return success("figma_component", input.action, {
            alreadyImported: false,
            ...imported,
          });
        }
        return success(
          "figma_component",
          input.action,
          await bridge.component(input),
        );
      });
    },
  );
}
