import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryFigmaBridge } from "../src/bridge/in-memory.js";
import type {
  FigmaFileFixture,
  ScreenshotPreparation,
} from "../src/bridge/types.js";
import { createMcpServer } from "../src/server.js";

const clients: Client[] = [];
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/core-file.json", import.meta.url), "utf8"),
) as FigmaFileFixture;

const preparation: ScreenshotPreparation = {
  fileName: "Fixture file",
  pageId: "1:0",
  scope: "viewport",
  focusNodeIds: [],
  viewportBounds: { x: 0, y: 0, width: 1200, height: 800 },
  leaseId: "capture-test-lease",
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function harness() {
  const bridge = new InMemoryFigmaBridge([fixture], "fixture-file");
  const visual = vi.fn(async () => ({ ...preparation }));
  bridge.visual = visual;
  const desktopCapture = vi.fn(async () => ({
    scope: "viewport" as const,
    focusNodeIds: [],
    mimeType: "image/png" as const,
    byteLength: 24,
    width: 1400,
    height: 900,
    scale: 1,
    path: "/tmp/fixture-window.png",
    window: {
      id: 42,
      name: "Fixture file",
      owner: "Figma",
      onScreen: true,
      bounds: { x: 0, y: 0, width: 1400, height: 900 },
    },
    viewportBounds: preparation.viewportBounds,
  }));
  const server = createMcpServer(
    { version: "test", profiles: ["core"], logLevel: "error" },
    { bridge, desktopCapture },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "screenshot-test", version: "test" });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, visual, desktopCapture };
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: "figma_screenshot", arguments: args }),
  );
  const text = result.content.find((item) => item.type === "text");
  return {
    result,
    payload: JSON.parse(text?.type === "text" ? text.text : "{}"),
  };
}

describe("figma_screenshot tool", () => {
  it("prepares scope through the Plugin bridge and returns Desktop proof", async () => {
    const { client, visual, desktopCapture } = await harness();
    const response = await call(client, {
      action: "capture",
      scope: "viewport",
      focus: true,
      scale: 1,
      maxBytes: 64_000,
      delayMs: 0,
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.payload).toMatchObject({
      ok: true,
      tool: "figma_screenshot",
      action: "capture",
      data: {
        artifact: {
          path: "/tmp/fixture-window.png",
          byteLength: 24,
          width: 1400,
          height: 900,
        },
        proof: {
          type: "desktop-window-screenshot",
          includesFigmaChrome: true,
        },
      },
    });
    expect(visual).toHaveBeenCalledWith({
      action: "prepare_capture",
      scope: "viewport",
      focus: true,
    });
    expect(desktopCapture).toHaveBeenCalledWith(preparation, {
      scale: 1,
      maxBytes: 64_000,
      delayMs: 0,
    });
    expect(visual).toHaveBeenNthCalledWith(2, {
      action: "release_capture",
      leaseId: "capture-test-lease",
    });
  });

  it("rejects malformed Plugin preparation and releases its lease", async () => {
    const { client, visual, desktopCapture } = await harness();
    visual.mockReset();
    visual.mockResolvedValue({
      ...preparation,
      scope: "../../outside",
    } as unknown as ScreenshotPreparation);

    const response = await call(client, {
      action: "capture",
      scope: "viewport",
      maxBytes: 64_000,
      delayMs: 0,
    });
    expect(response.result.isError).toBe(true);
    expect(desktopCapture).not.toHaveBeenCalled();
    expect(visual).toHaveBeenNthCalledWith(2, {
      action: "release_capture",
      leaseId: "capture-test-lease",
    });
  });

  it("rejects nodeIds outside node scope and missing node scope ids", async () => {
    const { client } = await harness();
    const invalidViewport = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_screenshot",
        arguments: {
          action: "capture",
          scope: "viewport",
          nodeIds: ["2:1"],
        },
      }),
    );
    expect(invalidViewport.isError).toBe(true);
    expect(JSON.stringify(invalidViewport.content)).toContain(
      "viewport scope does not accept nodeIds",
    );
    const invalidNode = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_screenshot",
        arguments: { action: "capture", scope: "node" },
      }),
    );
    expect(invalidNode.isError).toBe(true);
    expect(JSON.stringify(invalidNode.content)).toContain(
      "node scope requires nodeIds",
    );
  });
});
