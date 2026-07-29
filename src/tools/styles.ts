import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge, StyleActionInput } from "../bridge/types.js";
import type { ProfileName } from "../config.js";
import type { ConfirmationStore } from "../confirmations.js";
import { McpFigError } from "../errors.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";
import { writeControlSchema } from "./write-control.js";

const dryRun = z.boolean().optional();
const fileKey = z.string().min(1).optional();
const kind = z.enum(["PAINT", "TEXT", "EFFECT", "GRID"]);
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
    r: z.number().min(0).max(1),
    g: z.number().min(0).max(1),
    b: z.number().min(0).max(1),
  })
  .strict();
const rgba = rgb.extend({ a: z.number().min(0).max(1) }).strict();
const paint = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("SOLID"),
      color: rgb,
      opacity: z.number().min(0).max(1).optional(),
      visible: z.boolean().optional(),
      blendMode: blendMode.optional(),
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
      gradientTransform: z
        .array(z.array(z.number()).length(3))
        .length(2) as unknown as z.ZodType<
        [[number, number, number], [number, number, number]]
      >,
      gradientStops: z
        .array(
          z
            .object({
              position: z.number().min(0).max(1),
              color: rgba,
            })
            .strict(),
        )
        .min(2)
        .max(100),
      opacity: z.number().min(0).max(1).optional(),
      visible: z.boolean().optional(),
      blendMode: blendMode.optional(),
    })
    .strict(),
]);
const effect = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["DROP_SHADOW", "INNER_SHADOW"]),
      color: rgba,
      offset: z.object({ x: z.number(), y: z.number() }).strict(),
      radius: z.number().min(0),
      spread: z.number().optional(),
      visible: z.boolean(),
      blendMode,
    })
    .strict(),
  z
    .object({
      type: z.enum(["LAYER_BLUR", "BACKGROUND_BLUR"]),
      radius: z.number().min(0),
      visible: z.boolean(),
      blurType: z.literal("NORMAL"),
    })
    .strict(),
]);
const lineHeight = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("AUTO") }).strict(),
  z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number() }).strict(),
]);
const letterSpacing = z
  .object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number() })
  .strict();
const textProperties = z
  .object({
    fontName: z
      .object({ family: z.string().min(1), style: z.string().min(1) })
      .strict(),
    fontSize: z.number().positive(),
    lineHeight,
    letterSpacing,
    paragraphIndent: z.number().min(0).optional(),
    paragraphSpacing: z.number().min(0).optional(),
    textCase: z
      .enum([
        "ORIGINAL",
        "UPPER",
        "LOWER",
        "TITLE",
        "SMALL_CAPS",
        "SMALL_CAPS_FORCED",
      ])
      .optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  })
  .strict();
const grid = z.discriminatedUnion("pattern", [
  z
    .object({
      pattern: z.literal("GRID"),
      sectionSize: z.number().positive(),
      visible: z.boolean().optional(),
      color: rgba.optional(),
    })
    .strict(),
  z
    .object({
      pattern: z.enum(["COLUMNS", "ROWS"]),
      alignment: z.enum(["MIN", "MAX", "CENTER", "STRETCH"]),
      gutterSize: z.number().min(0),
      count: z.number().int().positive(),
      offset: z.number().min(0),
      visible: z.boolean().optional(),
      color: rgba.optional(),
    })
    .strict(),
]);
const common = {
  name: z.string().min(1),
  description: z.string().optional(),
};
const styleWrite = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("PAINT"),
      ...common,
      paints: z.array(paint).min(1).max(100),
    })
    .strict(),
  z
    .object({ kind: z.literal("TEXT"), ...common, text: textProperties })
    .strict(),
  z
    .object({
      kind: z.literal("EFFECT"),
      ...common,
      effects: z.array(effect).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("GRID"),
      ...common,
      grids: z.array(grid).min(1).max(100),
    })
    .strict(),
]);

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect"),
      kind: kind.optional(),
      styleIds: z.array(z.string().min(1)).min(1).max(200).optional(),
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      ...writeControlSchema,
      style: styleWrite,
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      ...writeControlSchema,
      styleId: z.string().min(1),
      style: styleWrite,
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      ...writeControlSchema,
      styleId: z.string().min(1),
      confirm: z.string().optional(),
      dryRun,
      fileKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("library_import"),
      ...writeControlSchema,
      styleKey: z.string().min(1),
      dryRun,
      fileKey,
    })
    .strict(),
]);

export function registerStylesTool(
  server: McpServer,
  bridge: FigmaBridge,
  profiles: ProfileName[],
  confirmations: ConfirmationStore,
): void {
  server.registerTool(
    "figma_styles",
    {
      title: "Figma styles",
      description:
        "Inspect and manage local paint, text, effect, and grid styles. Published library import is a separate known-key action.",
      inputSchema: exposeMcpInputSchema(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      const input = rawInput as StyleActionInput & { confirm?: string };
      return handleToolCall("figma_styles", input.action, async () => {
        if (
          input.action === "library_import" &&
          !profiles.includes("libraries")
        ) {
          throw new McpFigError(
            "UNSUPPORTED_BY_BRIDGE",
            "styles.library_import requires the libraries profile.",
          );
        }
        if (input.action === "delete") {
          const status = await bridge.status();
          const resolvedFileKey = input.fileKey ?? status.fileKey;
          if (!resolvedFileKey)
            throw new McpFigError(
              "FILE_NOT_TARGETED",
              "No Figma file is targeted.",
            );
          if (input.dryRun) {
            const data = await bridge.styles(input);
            return success("figma_styles", input.action, {
              ...data,
              destructive: true,
              dryRun: true,
              confirmationToken: confirmations.issue(
                "styles.delete",
                resolvedFileKey,
                [input.styleId],
              ),
            });
          }
          confirmations.consume(
            input.confirm,
            "styles.delete",
            resolvedFileKey,
            [input.styleId],
          );
        }
        return success(
          "figma_styles",
          input.action,
          await bridge.styles(input),
        );
      });
    },
  );
}
