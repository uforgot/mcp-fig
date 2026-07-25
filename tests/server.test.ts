import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../src/server.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function createConnectedClient() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    version: "0.0.0-test",
    profiles: ["core"],
    logLevel: "error",
  });
  const client = new Client({ name: "mcp-fig-test", version: "0.0.0" });
  clients.push(client);

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

describe("MCP server", () => {
  it("completes initialization and lists the implemented core tools", async () => {
    const client = await createConnectedClient();
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "figma_connection",
      "figma_document",
      "figma_selection",
      "figma_node",
    ]);
    expect(result.tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("returns an honest disconnected health status", async () => {
    const client = await createConnectedClient();
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_connection",
        arguments: { action: "status" },
      }),
    );
    const text = result.content.find((item) => item.type === "text");

    expect(text).toBeDefined();
    const payload = JSON.parse(text?.type === "text" ? text.text : "{}");
    expect(payload).toMatchObject({
      ok: true,
      tool: "figma_connection",
      action: "status",
      data: {
        connected: false,
        bridge: "not-configured",
      },
    });
  });

  it("returns a common error when a bridge-only tool is called disconnected", async () => {
    const client = await createConnectedClient();
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_document",
        arguments: { action: "inspect" },
      }),
    );
    const text = result.content.find((item) => item.type === "text");
    const payload = JSON.parse(text?.type === "text" ? text.text : "{}");

    expect(result.isError).toBe(true);
    expect(payload.error).toMatchObject({
      code: "NOT_CONNECTED",
      retryable: true,
    });
  });

  it("reports enabled profiles through capability discovery", async () => {
    const client = await createConnectedClient();
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_connection",
        arguments: { action: "capabilities" },
      }),
    );
    const text = result.content.find((item) => item.type === "text");
    const payload = JSON.parse(text?.type === "text" ? text.text : "{}");

    expect(payload.data).toMatchObject({
      profiles: ["core"],
      registeredTools: [
        "figma_connection",
        "figma_document",
        "figma_selection",
        "figma_node",
      ],
      dryRun: true,
      rawExecuteDryRun: false,
    });
  });
});
