import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RestFigmaBridge } from "../src/bridge/rest.js";
import { createMcpServer } from "../src/server.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("figma_collaboration", () => {
  it("lists and reads node-filtered comments only when collaboration is enabled", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        expect(request.headers.get("X-Figma-Token")).toBe("secret-token");
        expect(request.url).toBe(
          "https://api.figma.com/v1/files/file-1/comments",
        );
        return jsonResponse({
          comments: [
            {
              id: "comment-1",
              message: "Increase the hero contrast.",
              user: { id: "user-1", handle: "Shin", img_url: "avatar.png" },
              created_at: "2026-07-28T03:00:00Z",
              resolved_at: null,
              client_meta: {
                node_id: "66:2755",
                node_offset: { x: 12, y: 24 },
              },
            },
            {
              id: "comment-2",
              message: "Resolved note.",
              user: { handle: "Reviewer" },
              created_at: "2026-07-28T02:00:00Z",
              resolved_at: "2026-07-28T02:30:00Z",
              client_meta: { node_id: "62:8502" },
            },
          ],
        });
      },
    );
    const bridge = new RestFigmaBridge({
      accessToken: "secret-token",
      fileKey: "file-1",
      fetch: fetchMock,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer(
      {
        version: "0.0.0-test",
        profiles: ["core", "collaboration"],
        logLevel: "error",
      },
      { bridge },
    );
    const client = new Client({ name: "comments-test", version: "0.0.0" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "figma_collaboration",
    );

    const capabilities = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_connection",
        arguments: { action: "capabilities" },
      }),
    );
    const capabilitiesText = capabilities.content.find(
      (item) => item.type === "text",
    );
    const capabilitiesPayload = JSON.parse(
      capabilitiesText?.type === "text" ? capabilitiesText.text : "{}",
    );
    expect(capabilitiesPayload.data).toMatchObject({
      profiles: ["core", "collaboration"],
      registeredTools: expect.arrayContaining(["figma_collaboration"]),
    });

    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "figma_collaboration",
        arguments: {
          action: "comments",
          fileKey: "file-1",
          nodeIds: ["66:2755"],
          resolved: false,
          limit: 10,
        },
      }),
    );
    const text = result.content.find((item) => item.type === "text");
    const payload = JSON.parse(text?.type === "text" ? text.text : "{}");

    expect(result.isError).not.toBe(true);
    expect(payload).toMatchObject({
      ok: true,
      tool: "figma_collaboration",
      action: "comments",
      data: {
        comments: [
          {
            id: "comment-1",
            message: "Increase the hero contrast.",
            createdAt: "2026-07-28T03:00:00Z",
            resolvedAt: null,
            nodeId: "66:2755",
            nodeOffset: { x: 12, y: 24 },
            user: { id: "user-1", handle: "Shin", imgUrl: "avatar.png" },
          },
        ],
        count: 1,
        source: "rest",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
