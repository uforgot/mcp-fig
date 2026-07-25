import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FigmaBridge, FigmaNode } from "../bridge/types.js";
import { handleToolCall, success } from "../tool-result.js";

const fileKey = z.string().min(1).optional();
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), fileKey }).strict(),
  z.object({ action: z.literal("summary"), fileKey }).strict(),
  z.object({ action: z.literal("changes"), fileKey }).strict(),
]);

function summarize(root: FigmaNode) {
  const byType: Record<string, number> = {};
  let nodeCount = 0;
  const visit = (node: FigmaNode) => {
    nodeCount += 1;
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return { nodeCount, byType };
}

export function registerDocumentTool(
  server: McpServer,
  bridge: FigmaBridge,
): void {
  server.registerTool(
    "figma_document",
    {
      title: "Figma document",
      description:
        "Inspect the targeted document, summarize it, or read changes.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ action, fileKey: requestedFileKey }) =>
      handleToolCall("figma_document", action, async () => {
        if (action === "changes") {
          return success("figma_document", action, {
            changes: await bridge.getChanges(requestedFileKey),
          });
        }
        const document = await bridge.getDocument(requestedFileKey);
        if (action === "summary") {
          return success("figma_document", action, {
            document: {
              id: document.id,
              name: document.name,
              type: document.type,
            },
            ...summarize(document),
          });
        }
        return success("figma_document", action, { document });
      }),
  );
}
