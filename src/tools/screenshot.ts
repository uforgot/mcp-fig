import { rm } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  captureFigmaDesktop,
  type DesktopScreenshotOptions,
  SCREENSHOT_MAX_BYTES,
  type ScreenshotArtifact,
} from "../artifacts/screenshot.js";
import type { FigmaBridge, ScreenshotPreparation } from "../bridge/types.js";
import { McpFigError } from "../errors.js";
import { exposeMcpInputSchema } from "../mcp-schema.js";
import { handleToolCall, success } from "../tool-result.js";

const fileKey = z.string().min(1).optional();
const scopeSchema = z.enum(["viewport", "selection", "node"]);
const captureInput = z
  .object({
    action: z.literal("capture"),
    fileKey,
    scope: scopeSchema,
    nodeIds: z.array(z.string().min(1)).min(1).max(20).optional(),
    focus: z.boolean().default(true),
    scale: z.number().finite().min(0.25).max(1).default(1),
    maxBytes: z
      .number()
      .int()
      .min(64_000)
      .max(SCREENSHOT_MAX_BYTES)
      .default(SCREENSHOT_MAX_BYTES),
    delayMs: z.number().int().min(0).max(2_000).default(250),
  })
  .strict()
  .superRefine(({ scope, nodeIds }, context) => {
    if (scope === "node" && !nodeIds)
      context.addIssue({
        code: "custom",
        path: ["nodeIds"],
        message: "node scope requires nodeIds",
      });
    if (scope !== "node" && nodeIds)
      context.addIssue({
        code: "custom",
        path: ["nodeIds"],
        message: `${scope} scope does not accept nodeIds`,
      });
  });

const auditInput = z
  .object({
    action: z.literal("audit"),
    fileKey,
    rootNodeIds: z.array(z.string().min(1)).min(1).max(20),
    categories: z
      .array(z.enum(["accessibility", "design_system", "layout", "lint"]))
      .min(1)
      .max(4)
      .default(["accessibility", "design_system", "layout", "lint"]),
    maxDepth: z.number().int().min(0).max(10).default(6),
    maxNodes: z.number().int().min(1).max(500).default(250),
    maxIssues: z.number().int().min(1).max(200).default(100),
  })
  .strict();

const boundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();

const preparationSchema = z
  .object({
    fileName: z.string().min(1).max(512),
    pageId: z.string().min(1).max(256),
    scope: scopeSchema,
    focusNodeIds: z.array(z.string().min(1).max(256)).max(20),
    viewportBounds: boundsSchema,
    focusBounds: boundsSchema.optional(),
    leaseId: z.string().min(1).max(128),
  })
  .strict();

const leaseResponseSchema = z
  .object({ leaseId: z.string().min(1).max(128) })
  .passthrough();

const inputSchema = z.discriminatedUnion("action", [captureInput, auditInput]);
export type ScreenshotToolInput = z.infer<typeof inputSchema>;

export type DesktopCapture = (
  preparation: ScreenshotPreparation,
  options: DesktopScreenshotOptions,
) => Promise<ScreenshotArtifact>;

export function registerScreenshotTool(
  server: McpServer,
  bridge: FigmaBridge,
  desktopCapture: DesktopCapture = captureFigmaDesktop,
): void {
  server.registerTool(
    "figma_screenshot",
    {
      title: "Figma screenshot and audit",
      description:
        "Capture a bounded real Figma Desktop window PNG for viewport/selection/node focus, or run bounded model-state accessibility/design-system/layout/lint audits. Desktop screenshots, node exports, and audit evidence are distinct proof types.",
      inputSchema: exposeMcpInputSchema(inputSchema),
    },
    async (rawInput) => {
      const action =
        typeof rawInput.action === "string" ? rawInput.action : "unknown";
      return handleToolCall("figma_screenshot", action, async () => {
        const input = inputSchema.parse(rawInput);
        if (input.action === "audit")
          return success(
            "figma_screenshot",
            input.action,
            await bridge.visual({
              action: "audit",
              rootNodeIds: input.rootNodeIds,
              categories: input.categories,
              maxDepth: input.maxDepth,
              maxNodes: input.maxNodes,
              maxIssues: input.maxIssues,
              ...(input.fileKey ? { fileKey: input.fileKey } : {}),
            }),
          );

        const rawPreparation = await bridge.visual({
          action: "prepare_capture",
          scope: input.scope,
          ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
          focus: input.focus,
          ...(input.fileKey ? { fileKey: input.fileKey } : {}),
        });
        let preparation: ScreenshotPreparation;
        try {
          preparation = preparationSchema.parse(rawPreparation);
          if (preparation.scope !== input.scope)
            throw new McpFigError(
              "INVALID_ARGUMENT",
              "Plugin screenshot scope does not match the requested scope.",
            );
        } catch (error) {
          const lease = leaseResponseSchema.safeParse(rawPreparation);
          if (lease.success)
            await bridge
              .visual({
                action: "release_capture",
                leaseId: lease.data.leaseId,
                ...(input.fileKey ? { fileKey: input.fileKey } : {}),
              })
              .catch(() => undefined);
          throw error;
        }

        let artifact: ScreenshotArtifact | undefined;
        let captureError: unknown;
        try {
          artifact = await desktopCapture(preparation, {
            scale: input.scale,
            maxBytes: input.maxBytes,
            delayMs: input.delayMs,
          });
        } catch (error) {
          captureError = error;
        }
        let releaseError: unknown;
        try {
          await bridge.visual({
            action: "release_capture",
            leaseId: preparation.leaseId,
            ...(input.fileKey ? { fileKey: input.fileKey } : {}),
          });
        } catch (error) {
          releaseError = error;
        }
        if (releaseError) {
          if (artifact) await rm(artifact.path, { force: true });
          throw releaseError;
        }
        if (captureError) throw captureError;
        if (!artifact)
          throw new McpFigError(
            "INTERNAL_ERROR",
            "Desktop screenshot returned no artifact.",
          );
        return success("figma_screenshot", input.action, {
          artifact,
          proof: {
            type: "desktop-window-screenshot",
            includesFigmaChrome: true,
            scopeBehavior:
              input.scope === "viewport"
                ? "captures the current visible Figma Desktop window"
                : "focuses the requested selection/nodes, then captures the visible Figma Desktop window",
          },
        });
      });
    },
  );
}
