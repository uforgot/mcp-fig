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
  const client = new Client({ name: "mcp-fig-core-test", version: "0.0.0" });
  clients.push(client);

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }),
  );
  const text = result.content.find((item) => item.type === "text");
  return {
    result,
    payload: JSON.parse(text?.type === "text" ? text.text : "{}"),
  };
}

describe("Core Figma facade", () => {
  it("registers connection, document, selection, and node tools", async () => {
    const client = await createConnectedClient();
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "figma_connection",
      "figma_document",
      "figma_selection",
      "figma_node",
      "figma_layout",
      "figma_component",
      "figma_instance",
      "figma_tokens",
    ]);
  });

  it("enforces Figma's minimum font size at the MCP boundary", async () => {
    const client = await createConnectedClient();

    const invalid = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_node",
        arguments: {
          action: "update",
          nodeIds: ["2:1"],
          patch: { fontSize: 0.5 },
        },
      }),
    );
    expect(invalid.isError).toBe(true);

    const valid = await call(client, "figma_node", {
      action: "update",
      nodeIds: ["2:1"],
      patch: { fontSize: 1 },
    });
    expect(valid.payload.ok).toBe(true);
  });

  it("dispatches node export and rejects vector scale before bridge IO", async () => {
    const client = await createConnectedClient();

    const unsupported = await call(client, "figma_node", {
      action: "export",
      nodeIds: ["2:0"],
      format: "PNG",
      scale: 1,
    });
    expect(unsupported.payload).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_BY_BRIDGE" },
    });

    const invalid = await call(client, "figma_node", {
      action: "export",
      nodeIds: ["2:0"],
      format: "SVG",
      scale: 2,
    });
    expect(invalid.payload).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("reports the targeted fixture and reads document and selection", async () => {
    const client = await createConnectedClient();

    const status = await call(client, "figma_connection", { action: "status" });
    expect(status.payload.data).toMatchObject({
      connected: true,
      bridge: "fixture",
      fileKey: "fixture-file",
    });

    const document = await call(client, "figma_document", {
      action: "inspect",
    });
    expect(document.payload.data.document).toMatchObject({
      id: "0:0",
      name: "Core fixture",
      type: "DOCUMENT",
    });

    const selection = await call(client, "figma_selection", {
      action: "inspect",
    });
    expect(selection.payload.data).toMatchObject({
      nodeIds: ["2:1"],
      nodes: [{ id: "2:1", name: "Selected rectangle" }],
    });
  });

  it("queries nodes by bounded name, type, and exact path", async () => {
    const client = await createConnectedClient();

    const exact = await call(client, "figma_node", {
      action: "query",
      rootId: "1:0",
      name: "Card",
      nodeType: "FRAME",
      path: ["Layout root", "Card"],
      maxDepth: 4,
      limit: 10,
    });
    expect(exact.payload.data).toMatchObject({
      matches: [
        {
          path: ["Layout root", "Card"],
          node: { id: "4:1", type: "FRAME", name: "Card" },
        },
      ],
      limit: 10,
      truncated: false,
    });

    const bounded = await call(client, "figma_node", {
      action: "query",
      rootId: "1:0",
      nodeType: "FRAME",
      maxDepth: 4,
      limit: 2,
    });
    expect(bounded.payload.data).toMatchObject({
      matches: [
        { node: { id: "2:0" }, path: ["Destination"] },
        { node: { id: "4:0" }, path: ["Layout root"] },
      ],
      limit: 2,
      truncated: true,
    });

    const invalid = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_node",
        arguments: { action: "query", rootId: "1:0", limit: 10 },
      }),
    );
    expect(invalid.isError).toBe(true);
  });

  it("creates and updates typed visual properties with exact readback", async () => {
    const client = await createConnectedClient();
    const visual = {
      fills: [
        {
          type: "SOLID",
          color: { r: 0.1, g: 0.2, b: 0.3 },
          opacity: 0.9,
        },
        {
          type: "GRADIENT_LINEAR",
          gradientTransform: [
            [1, 0, 0],
            [0, 1, 0],
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
      strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }],
      opacity: 0.75,
      cornerRadius: 12,
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.2 },
          offset: { x: 0, y: 4 },
          radius: 8,
          spread: 1,
        },
      ],
      blendMode: "MULTIPLY",
      constraints: { horizontal: "CENTER", vertical: "TOP" },
    };
    const created = await call(client, "figma_node", {
      action: "create",
      parentId: "1:0",
      nodeType: "RECTANGLE",
      name: "Visual parity",
      props: visual,
    });
    const nodeId = created.payload.data.nodes[0].id as string;
    expect(created.payload.data.nodes[0]).toMatchObject(visual);

    const updated = await call(client, "figma_node", {
      action: "update",
      nodeIds: [nodeId],
      patch: {
        opacity: 0.5,
        cornerRadius: 20,
        blendMode: "SCREEN",
        constraints: { horizontal: "SCALE", vertical: "BOTTOM" },
      },
    });
    expect(updated.payload.data.nodes[0]).toMatchObject({
      opacity: 0.5,
      cornerRadius: 20,
      blendMode: "SCREEN",
      constraints: { horizontal: "SCALE", vertical: "BOTTOM" },
    });

    const readback = await call(client, "figma_node", {
      action: "get",
      nodeIds: [nodeId],
    });
    expect(readback.payload.data.nodes[0]).toEqual(
      updated.payload.data.nodes[0],
    );
  });

  it("rejects mixed and unsupported visual writes at the MCP boundary", async () => {
    const client = await createConnectedClient();
    const patches = [
      { opacity: 1.1 },
      { cornerRadius: { mixed: true } },
      { fills: [{ type: "IMAGE", imageHash: "hash" }] },
      { effects: [{ type: "NOISE", noiseSize: 1 }] },
    ];

    for (const patch of patches) {
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "figma_node",
          arguments: { action: "update", nodeIds: ["2:1"], patch },
        }),
      );
      expect(result.isError).toBe(true);
    }
  });

  it("creates, updates, moves, resizes, clones, and deletes a node", async () => {
    const client = await createConnectedClient();

    const created = await call(client, "figma_node", {
      action: "create",
      parentId: "1:0",
      nodeType: "RECTANGLE",
      name: "Card background",
      props: { x: 10, y: 20, width: 120, height: 64 },
    });
    const createdId = created.payload.data.nodes[0].id as string;
    expect(created.payload.data.nodes[0]).toMatchObject({
      parentId: "1:0",
      width: 120,
      height: 64,
    });

    const updated = await call(client, "figma_node", {
      action: "update",
      nodeIds: [createdId],
      patch: { name: "Card surface", visible: true },
    });
    expect(updated.payload.data.nodes[0].name).toBe("Card surface");

    const moved = await call(client, "figma_node", {
      action: "move",
      nodeIds: [createdId],
      parentId: "2:0",
      index: 0,
      x: 24,
      y: 32,
    });
    expect(moved.payload.data.nodes[0]).toMatchObject({
      parentId: "2:0",
      x: 24,
      y: 32,
    });

    const resized = await call(client, "figma_node", {
      action: "resize",
      nodeIds: [createdId],
      size: { width: 240, height: 96 },
    });
    expect(resized.payload.data.nodes[0]).toMatchObject({
      width: 240,
      height: 96,
    });

    const cloned = await call(client, "figma_node", {
      action: "clone",
      nodeIds: [createdId],
      offset: { x: 16, y: 16 },
    });
    const cloneId = cloned.payload.data.nodes[0].id as string;
    expect(cloned.payload.data.nodes[0]).toMatchObject({
      parentId: "2:0",
      x: 40,
      y: 48,
    });
    expect(cloneId).not.toBe(createdId);

    const unconfirmed = await call(client, "figma_node", {
      action: "delete",
      nodeIds: [cloneId],
    });
    expect(unconfirmed.result.isError).toBe(true);
    expect(unconfirmed.payload.error.code).toBe("CONFIRMATION_REQUIRED");

    const preview = await call(client, "figma_node", {
      action: "delete",
      nodeIds: [cloneId],
      dryRun: true,
    });
    expect(preview.payload.data).toMatchObject({
      destructive: true,
      nodeIds: [cloneId],
    });
    expect(preview.payload.data.confirmationToken).toEqual(expect.any(String));

    const deleted = await call(client, "figma_node", {
      action: "delete",
      nodeIds: [cloneId],
      confirm: preview.payload.data.confirmationToken,
    });
    expect(deleted.payload.data.deletedNodeIds).toEqual([cloneId]);

    const changes = await call(client, "figma_document", {
      action: "changes",
    });
    expect(
      changes.payload.data.changes.map(
        (change: { action: string }) => change.action,
      ),
    ).toEqual(["create", "update", "move", "resize", "clone", "delete"]);

    const missing = await call(client, "figma_node", {
      action: "get",
      nodeIds: [cloneId],
    });
    expect(missing.result.isError).toBe(true);
    expect(missing.payload.error).toMatchObject({
      code: "NODE_NOT_FOUND",
      retryable: false,
    });
  });

  it("rejects destructive calls without explicit target IDs", async () => {
    const client = await createConnectedClient();
    const invalid = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_node",
        arguments: { action: "delete", dryRun: true },
      }),
    );
    const text = invalid.content.find((item) => item.type === "text");

    expect(invalid.isError).toBe(true);
    expect(text?.type === "text" ? text.text : "").toContain(
      "MCP error -32602",
    );
  });
});
