import { describe, expect, it } from "vitest";

import { currentTraceId } from "../src/observability/trace-context.js";
import { handleToolCall, success } from "../src/tool-result.js";

describe("MCP tool trace context", () => {
  it("returns the same traceId used by downstream async work", async () => {
    let downstreamTrace: string | undefined;
    const response = await handleToolCall("figma_node", "get", async () => {
      await Promise.resolve();
      downstreamTrace = currentTraceId();
      return success("figma_node", "get", { nodes: [] });
    });
    const content = response.content[0];
    const payload = JSON.parse(
      content?.type === "text" ? content.text : "{}",
    ) as {
      traceId?: string;
    };
    expect(downstreamTrace).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.traceId).toBe(downstreamTrace);
  });
});
