import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryFigmaBridge } from "../src/bridge/in-memory.js";
import type { FigmaFileFixture, FigmaNode } from "../src/bridge/types.js";
import type { ProfileName } from "../src/config.js";
import { createMcpServer } from "../src/server.js";

const clients: Client[] = [];
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/core-file.json", import.meta.url), "utf8"),
) as FigmaFileFixture;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function createConnectedClient(profiles: ProfileName[] = ["core"]) {
  const bridge = new InMemoryFigmaBridge([fixture], "fixture-file");
  const server = createMcpServer(
    {
      version: "0.0.0-test",
      profiles,
      logLevel: "error",
    },
    { bridge },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "mcp-fig-design-system-test",
    version: "0.0.0",
  });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, bridge };
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

function fixtureNode(root: FigmaNode, id: string): FigmaNode {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    try {
      return fixtureNode(child, id);
    } catch {}
  }
  throw new Error(`Fixture node ${id} was not found.`);
}

describe("Component, instance, and token facade", () => {
  it("completes component search through token binding in five calls", async () => {
    const { client, bridge } = await createConnectedClient();
    let workflowCalls = 0;

    const search = await call(client, "figma_component", {
      action: "search",
      query: "button",
    });
    workflowCalls += 1;
    expect(search.payload.data.components).toEqual([
      expect.objectContaining({
        source: "local",
        nodeId: "3:0",
        key: "local-button-key",
        name: "Button",
      }),
    ]);

    const created = await call(client, "figma_instance", {
      action: "create",
      componentId: "3:0",
      parentId: "2:0",
      properties: { State: "Default", Label: "Continue" },
    });
    workflowCalls += 1;
    const instanceId = created.payload.data.instances[0].id as string;

    const updated = await call(client, "figma_instance", {
      action: "update",
      instanceIds: [instanceId],
      properties: { State: "Hover" },
    });
    workflowCalls += 1;
    expect(updated.payload.data.instances[0].instanceProperties.State).toBe(
      "Hover",
    );

    const tokens = await call(client, "figma_tokens", { action: "inspect" });
    workflowCalls += 1;
    expect(tokens.payload.data.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "variable:brand",
          collectionId: "collection:color",
        }),
      ]),
    );

    await call(client, "figma_tokens", {
      action: "apply",
      operations: [
        {
          op: "bind",
          nodeIds: [instanceId],
          field: "fills",
          variableId: "variable:brand",
        },
      ],
    });
    workflowCalls += 1;

    expect(workflowCalls).toBeLessThanOrEqual(5);
    expect(await bridge.getNodes([instanceId])).toEqual([
      expect.objectContaining({
        mainComponentId: "3:0",
        instanceProperties: expect.objectContaining({ State: "Hover" }),
        boundVariables: { fills: "variable:brand" },
      }),
    ]);
  });

  it("rejects unknown fixture properties when definitions are absent", async () => {
    const custom = structuredClone(fixture);
    const component = fixtureNode(custom.document, "3:0");
    delete component.componentProperties;
    const bridge = new InMemoryFigmaBridge([custom], "fixture-file");
    await expect(
      bridge.instance({
        action: "create",
        componentId: "3:0",
        parentId: "2:0",
        properties: { Rogue: "value" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("prevalidates fixture update and reset batches before mutation", async () => {
    const custom = structuredClone(fixture);
    const frame = fixtureNode(custom.document, "2:0");
    frame.children = [
      {
        id: "instance:valid",
        type: "INSTANCE",
        name: "Valid",
        parentId: frame.id,
        mainComponentId: "3:0",
        instanceProperties: { Label: "Before", State: "Default" },
        children: [],
      },
      {
        id: "instance:invalid",
        type: "INSTANCE",
        name: "Invalid",
        parentId: frame.id,
        mainComponentId: "missing:component",
        instanceProperties: { Label: "Invalid", State: "Default" },
        children: [],
      },
    ];
    const bridge = new InMemoryFigmaBridge([custom], "fixture-file");
    await expect(
      bridge.instance({
        action: "update",
        instanceIds: ["instance:valid", "instance:invalid"],
        properties: { Label: "After" },
      }),
    ).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
    expect((await bridge.getNodes(["instance:valid"]))[0]).toMatchObject({
      instanceProperties: { Label: "Before", State: "Default" },
    });
    await expect(
      bridge.instance({
        action: "reset",
        instanceIds: ["instance:valid", "instance:invalid"],
      }),
    ).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
    expect((await bridge.getNodes(["instance:valid"]))[0]).toMatchObject({
      instanceProperties: { Label: "Before", State: "Default" },
    });
  });

  it("keeps library components key-addressed and profile-gated", async () => {
    const { client } = await createConnectedClient(["core", "libraries"]);
    const result = await call(client, "figma_component", {
      action: "library_search",
      query: "card",
    });

    expect(result.payload.data.components).toEqual([
      expect.objectContaining({
        source: "library",
        key: "library-card-key",
        name: "Card",
      }),
    ]);

    const { client: coreClient } = await createConnectedClient();
    const rejected = CallToolResultSchema.parse(
      await coreClient.callTool({
        name: "figma_component",
        arguments: { action: "library_search", query: "card" },
      }),
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("-32602"),
    });
  });

  it("creates physical fixture slots and mutates their instance tree", async () => {
    const { client } = await createConnectedClient(["core", "libraries"]);
    const createdSlot = await call(client, "figma_component", {
      action: "slot_create",
      componentId: "3:0",
      slotName: "Content",
      allowedComponentKeys: ["library-card-key"],
    });
    expect(createdSlot.payload.data.slot).toMatchObject({
      type: "SLOT",
      name: "Content",
      children: [],
    });
    const created = await call(client, "figma_instance", {
      action: "create",
      componentId: "3:0",
      parentId: "2:0",
    });
    expect(created.payload).toMatchObject({
      data: { instances: [expect.objectContaining({ type: "INSTANCE" })] },
    });
    const instanceId = created.payload.data.instances[0].id as string;
    const appended = await call(client, "figma_instance", {
      action: "slot_append",
      instanceId,
      slotName: "Content",
      componentKey: "library-card-key",
    });
    expect(appended.payload.data.slot.children).toEqual([
      expect.objectContaining({
        type: "INSTANCE",
        mainComponentKey: "library-card-key",
      }),
    ]);
    const reset = await call(client, "figma_instance", {
      action: "slot_reset",
      instanceId,
      slotName: "Content",
    });
    expect(reset.payload.data.slot.children).toEqual([]);
  });

  it("imports a key-addressed library component and supports inspect swap reset", async () => {
    const { client } = await createConnectedClient(["core", "libraries"]);
    const imported = await call(client, "figma_component", {
      action: "library_import",
      componentKey: "library-card-key",
      kind: "COMPONENT",
    });
    expect(imported.payload.data.imported).toMatchObject({
      source: "library",
      kind: "COMPONENT",
      key: "library-card-key",
      name: "Card",
    });
    expect(imported.payload.data.node).toMatchObject({
      type: "COMPONENT",
      componentKey: "library-card-key",
    });

    const created = await call(client, "figma_instance", {
      action: "create",
      componentId: "3:0",
      parentId: "2:0",
      properties: { Label: "Overridden" },
    });
    const instanceId = created.payload.data.instances[0].id as string;
    const swapped = await call(client, "figma_instance", {
      action: "swap",
      instanceIds: [instanceId],
      componentKey: "library-card-key",
      preserveOverrides: true,
    });
    expect(swapped.payload.data.instances[0]).toMatchObject({
      mainComponentKey: "library-card-key",
      instanceProperties: expect.objectContaining({ Label: "Overridden" }),
    });
    const inspected = await call(client, "figma_instance", {
      action: "inspect",
      instanceIds: [instanceId],
    });
    expect(inspected.payload.data.instances[0].mainComponentKey).toBe(
      "library-card-key",
    );
    const reset = await call(client, "figma_instance", {
      action: "reset",
      instanceIds: [instanceId],
    });
    expect(reset.payload.data.instances[0].instanceProperties).toEqual({});
  });

  it("preserves variable aliases and applies explicit collection modes", async () => {
    const { client } = await createConnectedClient();
    const initial = await call(client, "figma_tokens", { action: "inspect" });
    expect(initial.payload.data.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "variable:accent",
          valuesByMode: {
            "mode:light": {
              type: "VARIABLE_ALIAS",
              id: "variable:brand",
            },
          },
        }),
      ]),
    );

    await call(client, "figma_tokens", {
      action: "apply",
      operations: [
        {
          op: "mode_add",
          collectionId: "collection:color",
          modeId: "mode:dark",
          name: "Dark",
        },
        {
          op: "alias",
          variableId: "variable:accent",
          modeId: "mode:dark",
          targetVariableId: "variable:brand",
        },
      ],
    });

    const inspected = await call(client, "figma_tokens", {
      action: "inspect",
    });
    expect(inspected.payload.data.collections[0].modes).toContainEqual({
      id: "mode:dark",
      name: "Dark",
    });
    expect(
      inspected.payload.data.variables.find(
        (variable: { id: string }) => variable.id === "variable:accent",
      ).valuesByMode["mode:dark"],
    ).toEqual({ type: "VARIABLE_ALIAS", id: "variable:brand" });

    const cycle = await call(client, "figma_tokens", {
      action: "apply",
      operations: [
        {
          op: "alias",
          variableId: "variable:brand",
          modeId: "mode:dark",
          targetVariableId: "variable:accent",
        },
      ],
    });
    expect(cycle.result.isError).toBe(true);
    expect(cycle.payload.error.code).toBe("INVALID_ARGUMENT");
  });

  it("keeps generated IDs deterministic across preview and apply", async () => {
    const { bridge } = await createConnectedClient();
    const preview = await bridge.instance({
      action: "create",
      componentId: "3:0",
      parentId: "2:0",
      dryRun: true,
    });
    const applied = await bridge.instance({
      action: "create",
      componentId: "3:0",
      parentId: "2:0",
    });
    expect((preview.instances as Array<{ id: string }>)[0]?.id).toBe(
      (applied.instances as Array<{ id: string }>)[0]?.id,
    );

    const collectionPreview = await bridge.tokens({
      action: "collection_create",
      name: "Spacing",
      dryRun: true,
    });
    const collectionApplied = await bridge.tokens({
      action: "collection_create",
      name: "Spacing",
    });
    expect((collectionPreview.collection as { id: string }).id).toBe(
      (collectionApplied.collection as { id: string }).id,
    );
  });

  it("requires target-bound confirmation before deleting a collection", async () => {
    const { client } = await createConnectedClient();
    const preview = await call(client, "figma_tokens", {
      action: "collection_delete",
      collectionId: "collection:color",
      dryRun: true,
    });
    const token = preview.payload.data.confirmationToken as string;
    expect(token).toBeTruthy();

    const unconfirmed = await call(client, "figma_tokens", {
      action: "collection_delete",
      collectionId: "collection:color",
    });
    expect(unconfirmed.result.isError).toBe(true);
    expect(unconfirmed.payload.error.code).toBe("CONFIRMATION_REQUIRED");

    const deleted = await call(client, "figma_tokens", {
      action: "collection_delete",
      collectionId: "collection:color",
      confirm: token,
    });
    expect(deleted.payload.data.deletedCollectionId).toBe("collection:color");
  });
});
