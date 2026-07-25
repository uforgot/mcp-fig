import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryFigmaBridge } from "../src/bridge/in-memory.js";
import type { FigmaFileFixture } from "../src/bridge/types.js";
import { createMcpServer } from "../src/server.js";

const clients: Client[] = [];
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/core-file.json", import.meta.url), "utf8"),
) as FigmaFileFixture;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function createConnectedClient() {
  const bridge = new InMemoryFigmaBridge([fixture], "fixture-file");
  const server = createMcpServer(
    {
      version: "0.0.0-test",
      profiles: ["core"],
      logLevel: "error",
    },
    { bridge },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "mcp-fig-layout-test",
    version: "0.0.0",
  });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: "figma_layout", arguments: args }),
  );
  const text = result.content.find((item) => item.type === "text");
  return {
    result,
    payload: JSON.parse(text?.type === "text" ? text.text : "{}"),
  };
}

describe("Auto Layout facade", () => {
  it("previews and applies nested parent, child sizing, and constraints in dependency order", async () => {
    const client = await createConnectedClient();
    const before = await call(client, {
      action: "inspect",
      nodeIds: ["4:0", "4:1", "4:2"],
    });
    expect(before.payload.data.layouts).toEqual([
      expect.objectContaining({
        nodeId: "4:0",
        layout: expect.objectContaining({ layoutMode: "NONE" }),
      }),
      expect.objectContaining({
        nodeId: "4:1",
        sizing: { horizontal: "FIXED", vertical: "FIXED" },
      }),
      expect.objectContaining({
        nodeId: "4:2",
        constraints: { horizontal: "LEFT", vertical: "TOP" },
      }),
    ]);

    const operations = [
      {
        op: "constraints",
        nodeIds: ["4:1"],
        constraints: { horizontal: "LEFT_RIGHT", vertical: "TOP" },
      },
      {
        op: "sizing",
        nodeIds: ["4:2"],
        sizing: { horizontal: "HUG", vertical: "HUG" },
      },
      {
        op: "sizing",
        nodeIds: ["4:1"],
        sizing: {
          horizontal: "FILL",
          vertical: "HUG",
          minWidth: 240,
          maxWidth: 560,
        },
      },
      {
        op: "apply",
        nodeIds: ["4:1"],
        layout: {
          layoutMode: "HORIZONTAL",
          itemSpacing: 8,
          padding: { top: 12, right: 16, bottom: 12, left: 16 },
          primaryAxisAlignItems: "MIN",
          counterAxisAlignItems: "CENTER",
          layoutWrap: "NO_WRAP",
        },
      },
      {
        op: "apply",
        nodeIds: ["4:0"],
        layout: {
          layoutMode: "VERTICAL",
          itemSpacing: 16,
          padding: 20,
          primaryAxisAlignItems: "MIN",
          counterAxisAlignItems: "CENTER",
          layoutWrap: "NO_WRAP",
        },
      },
    ];

    const preview = await call(client, {
      action: "batch",
      operations,
      dryRun: true,
    });
    expect(preview.payload.data.appliedOrder).toEqual([
      "apply:4:0",
      "apply:4:1",
      "sizing:4:1",
      "sizing:4:2",
      "constraints:4:1",
    ]);
    expect(preview.payload.data.after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "4:0",
          layout: expect.objectContaining({
            layoutMode: "VERTICAL",
            itemSpacing: 16,
            padding: { top: 20, right: 20, bottom: 20, left: 20 },
          }),
        }),
        expect.objectContaining({
          nodeId: "4:1",
          sizing: expect.objectContaining({
            horizontal: "FILL",
            vertical: "HUG",
            minWidth: 240,
            maxWidth: 560,
          }),
          constraints: { horizontal: "LEFT_RIGHT", vertical: "TOP" },
        }),
      ]),
    );

    const unchanged = await call(client, {
      action: "inspect",
      nodeIds: ["4:0", "4:1", "4:2"],
    });
    expect(unchanged.payload.data.layouts).toEqual(before.payload.data.layouts);

    const applied = await call(client, {
      action: "batch",
      operations,
    });
    expect(applied.payload.data.after).toEqual(preview.payload.data.after);

    const resized = await call(client, {
      action: "sizing",
      nodeIds: ["4:1"],
      sizing: { horizontal: "FILL", vertical: "HUG" },
    });
    expect(resized.payload.data.after[0].sizing).toMatchObject({
      horizontal: "FILL",
      vertical: "HUG",
      minWidth: 240,
      maxWidth: 560,
    });
    const invalidExistingBounds = await call(client, {
      action: "sizing",
      nodeIds: ["4:1"],
      sizing: {
        horizontal: "FILL",
        vertical: "HUG",
        minWidth: 600,
      },
    });
    expect(invalidExistingBounds.payload.error.code).toBe("INVALID_ARGUMENT");

    const after = await call(client, {
      action: "inspect",
      nodeIds: ["4:0", "4:1", "4:2"],
    });
    expect(after.payload.data.layouts).toEqual(preview.payload.data.after);
  });

  it("previews a direct apply action without changing the document", async () => {
    const client = await createConnectedClient();
    const preview = await call(client, {
      action: "apply",
      nodeIds: ["4:0"],
      layout: {
        layoutMode: "VERTICAL",
        gap: 24,
        padding: 12,
      },
      dryRun: true,
    });
    expect(preview.payload.data.after[0].layout).toMatchObject({
      layoutMode: "VERTICAL",
      gap: 24,
      itemSpacing: 24,
      padding: { top: 12, right: 12, bottom: 12, left: 12 },
    });
    const inspected = await call(client, {
      action: "inspect",
      nodeIds: ["4:0"],
    });
    expect(inspected.payload.data.layouts[0].layout.layoutMode).toBe("NONE");
  });

  it("rolls back an entire batch when a later operation is invalid", async () => {
    const client = await createConnectedClient();
    const invalid = await call(client, {
      action: "batch",
      operations: [
        {
          op: "apply",
          nodeIds: ["4:0"],
          layout: { layoutMode: "VERTICAL", itemSpacing: 16 },
        },
        {
          op: "sizing",
          nodeIds: ["4:1"],
          sizing: {
            horizontal: "FILL",
            vertical: "HUG",
            minWidth: 500,
            maxWidth: 300,
          },
        },
      ],
    });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.payload.error.code).toBe("INVALID_ARGUMENT");

    const inspected = await call(client, {
      action: "inspect",
      nodeIds: ["4:0", "4:1"],
    });
    expect(inspected.payload.data.layouts[0].layout.layoutMode).toBe("NONE");
    expect(inspected.payload.data.layouts[1].sizing).toEqual({
      horizontal: "FIXED",
      vertical: "FIXED",
    });
  });

  it("rejects contradictory sizing bounds without mutating the node", async () => {
    const client = await createConnectedClient();
    const invalid = await call(client, {
      action: "sizing",
      nodeIds: ["4:1"],
      sizing: {
        horizontal: "FIXED",
        vertical: "FIXED",
        minWidth: 300,
        maxWidth: 200,
      },
    });

    expect(invalid.result.isError).toBe(true);
    expect(invalid.payload.error.code).toBe("INVALID_ARGUMENT");
    const inspected = await call(client, {
      action: "inspect",
      nodeIds: ["4:1"],
    });
    expect(inspected.payload.data.layouts[0].sizing).toEqual({
      horizontal: "FIXED",
      vertical: "FIXED",
    });
  });
});
