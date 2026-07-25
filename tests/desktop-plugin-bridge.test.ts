import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopPluginBridgeHost,
  DesktopPluginFigmaBridge,
} from "../src/bridge/desktop-plugin.js";
import type {
  PluginCommand,
  PluginHandshake,
  PluginResult,
} from "../src/bridge/plugin-protocol.js";
import { createMcpServer } from "../src/server.js";

const hosts: DesktopPluginBridgeHost[] = [];
const aborters: AbortController[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const aborter of aborters.splice(0)) aborter.abort();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.status).toBeLessThan(400);
  return (await response.json()) as T;
}

function startFakePlugin(
  baseUrl: string,
  token: string,
  fileKey = "file-live",
) {
  const aborter = new AbortController();
  aborters.push(aborter);
  const handshake: PluginHandshake = {
    protocol: "mcp-fig-plugin/v1",
    sessionId: "session-a",
    clientId: "figma-plugin-ui",
    file: { key: fileKey, name: "Live file", revision: "7" },
    capabilities: [
      "document.read",
      "selection.read",
      "node.read",
      "node.write",
      "layout.write",
      "component.write",
      "instance.write",
      "tokens.write",
    ],
    sentAt: new Date().toISOString(),
  };

  const loop = (async () => {
    await json(`${baseUrl}/v1/session/handshake`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(handshake),
      signal: aborter.signal,
    });

    while (!aborter.signal.aborted) {
      const response = await fetch(`${baseUrl}/v1/session/session-a/next`, {
        headers: { authorization: `Bearer ${token}` },
        signal: aborter.signal,
      });
      if (response.status === 204) continue;
      const command = (await response.json()) as PluginCommand;
      let data: unknown;
      if (command.method === "document.summary") {
        data = {
          document: { id: "0:0", name: "Live file", type: "DOCUMENT" },
          nodeCount: 2,
          byType: { DOCUMENT: 1, RECTANGLE: 1 },
        };
      } else if (command.method === "selection.get") data = ["2:1"];
      else if (command.method === "node.get") {
        data = [
          { id: "2:1", type: "RECTANGLE", name: "Live node", parentId: "1:0" },
        ];
      } else if (command.method === "node.update") {
        data = [
          {
            id: "2:1",
            type: "RECTANGLE",
            name: "Updated live node",
            parentId: "1:0",
          },
        ];
      } else if (command.method === "layout") {
        data = { issues: [], repaired: true };
      } else data = {};

      const result: PluginResult = {
        protocol: "mcp-fig-plugin/v1",
        requestId: command.requestId,
        clientId: command.clientId,
        sessionId: command.sessionId,
        fileKey: command.fileKey,
        ok: true,
        revision: command.method === "node.update" ? "8" : "7",
        data,
        pluginReceivedAt: command.dispatchedAt,
        figmaApiCompletedAt: new Date().toISOString(),
        sceneTraversalNodeCount: command.method === "node.get" ? 1 : 0,
        receivedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      await json(`${baseUrl}/v1/session/session-a/result`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(result),
        signal: aborter.signal,
      });
    }
  })().catch((error: unknown) => {
    if (!aborter.signal.aborted) throw error;
  });
  return { loop, aborter };
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

describe("Desktop Plugin bridge", () => {
  it("closes safely after a failed bind", async () => {
    const owner = new DesktopPluginBridgeHost({ token: "owner", port: 0 });
    hosts.push(owner);
    const address = await owner.listen();
    const blocked = new DesktopPluginBridgeHost({
      token: "blocked",
      port: address.port,
    });
    hosts.push(blocked);

    await expect(blocked.listen()).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await expect(blocked.close()).resolves.toBeUndefined();
  });

  it("does not finish binding after close races listen", async () => {
    const host = new DesktopPluginBridgeHost({ token: "race", port: 0 });
    hosts.push(host);
    const listening = host.listen().then(
      () => "listened",
      () => "closed",
    );

    await host.close();

    expect(await listening).toBe("closed");
  });

  it("rejects a wrong token, target file, and mismatched result correlation", async () => {
    const host = new DesktopPluginBridgeHost({ token: "pair-secret", port: 0 });
    hosts.push(host);
    const address = await host.listen();

    const unauthorized = await fetch(`${address.url}/v1/session/handshake`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(unauthorized.status).toBe(401);

    startFakePlugin(address.url, "pair-secret");
    await host.waitForSession("file-live", 1_000);
    const bridge = new DesktopPluginFigmaBridge(host, { clientId: "agent-a" });

    await expect(bridge.getSelection("other-file")).rejects.toMatchObject({
      code: "FILE_NOT_TARGETED",
    });

    const pending = bridge.getSelection("file-live");
    const badResult = await fetch(
      `${address.url}/v1/session/session-a/result`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer pair-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "mcp-fig-plugin/v1",
          requestId: "wrong-request",
          clientId: "agent-a",
          sessionId: "session-a",
          fileKey: "file-live",
          ok: true,
          data: [],
          receivedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      },
    );
    expect(badResult.status).toBe(409);
    await expect(pending).resolves.toEqual(["2:1"]);
  });

  it("round-trips typed MCP selection, node write, and layout repair through localhost", async () => {
    const host = new DesktopPluginBridgeHost({ token: "pair-secret", port: 0 });
    hosts.push(host);
    const address = await host.listen();
    startFakePlugin(address.url, "pair-secret");
    await host.waitForSession("file-live", 1_000);

    const bridge = new DesktopPluginFigmaBridge(host, {
      clientId: "mcp-client-a",
      requestTimeoutMs: 1_000,
    });
    const server = createMcpServer(
      { version: "test", profiles: ["core"], logLevel: "error" },
      { bridge },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-test", version: "1" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const selection = await call(client, "figma_selection", {
      action: "inspect",
    });
    expect(selection.payload.data.nodes[0]).toMatchObject({
      id: "2:1",
      name: "Live node",
    });

    const summary = await call(client, "figma_document", {
      action: "summary",
    });
    expect(summary.payload.data).toMatchObject({
      nodeCount: 2,
      byType: { DOCUMENT: 1, RECTANGLE: 1 },
    });

    const update = await call(client, "figma_node", {
      action: "update",
      nodeIds: ["2:1"],
      patch: { name: "Updated live node" },
      fileKey: "file-live",
    });
    expect(update.payload.data.nodes[0].name).toBe("Updated live node");
    await expect(bridge.listFiles()).resolves.toContainEqual({
      key: "file-live",
      name: "Live file",
      revision: "8",
    });

    const repaired = await call(client, "figma_layout", {
      action: "repair",
      nodeIds: ["2:1"],
      issueCodes: ["FILL_WITHOUT_AUTO_LAYOUT_PARENT"],
      fileKey: "file-live",
    });
    expect(repaired.payload.data).toMatchObject({ repaired: true, issues: [] });

    expect(host.metrics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientId: "mcp-client-a",
          sessionId: "session-a",
          fileKey: "file-live",
          serverReceivedAt: expect.any(String),
          bridgeSentAt: expect.any(String),
          pluginReceivedAt: expect.any(String),
          figmaApiCompletedAt: expect.any(String),
          responseCompletedAt: expect.any(String),
          requestBytes: expect.any(Number),
          responseBytes: expect.any(Number),
          sceneTraversalNodeCount: expect.any(Number),
        }),
      ]),
    );
    const metricResponse = await json<{
      metrics: Array<{ requestBytes: number; responseBytes: number }>;
    }>(`${address.url}/v1/metrics`, {
      headers: { authorization: "Bearer pair-secret" },
    });
    expect(metricResponse.metrics.at(-1)).toMatchObject({
      requestBytes: expect.any(Number),
      responseBytes: expect.any(Number),
    });
  });

  it("drops 100 timed-out queued writes before a reconnect can execute them", async () => {
    const host = new DesktopPluginBridgeHost({
      token: "pair-secret",
      port: 0,
      requestTimeoutMs: 5,
    });
    hosts.push(host);
    const address = await host.listen();
    await json(`${address.url}/v1/session/handshake`, {
      method: "POST",
      headers: {
        authorization: "Bearer pair-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "mcp-fig-plugin/v1",
        sessionId: "session-a",
        clientId: "figma-plugin-ui",
        file: { key: "file-live", name: "Live file", revision: "7" },
        capabilities: ["node.write"],
        sentAt: new Date().toISOString(),
      }),
    });

    for (let index = 0; index < 100; index += 1) {
      await expect(
        host.request("agent-a", "node.update", {
          nodeIds: ["2:1"],
          patch: { name: `write-${index}` },
        }),
      ).rejects.toMatchObject({ code: "NOT_CONNECTED", retryable: true });
    }

    const next = await fetch(`${address.url}/v1/session/session-a/next`, {
      headers: { authorization: "Bearer pair-secret" },
    });
    expect(next.status).toBe(204);
  });

  it("reports UNKNOWN_OUTCOME without retrying a dispatched write", async () => {
    const host = new DesktopPluginBridgeHost({
      token: "pair-secret",
      port: 0,
      requestTimeoutMs: 20,
    });
    hosts.push(host);
    const address = await host.listen();
    await json(`${address.url}/v1/session/handshake`, {
      method: "POST",
      headers: {
        authorization: "Bearer pair-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "mcp-fig-plugin/v1",
        sessionId: "session-a",
        clientId: "figma-plugin-ui",
        file: { key: "file-live", name: "Live file", revision: "7" },
        capabilities: ["node.write"],
        sentAt: new Date().toISOString(),
      }),
    });
    const next = fetch(`${address.url}/v1/session/session-a/next`, {
      headers: { authorization: "Bearer pair-secret" },
    });
    const write = host.request("agent-a", "node.update", {
      nodeIds: ["2:1"],
      patch: { name: "possibly-applied" },
    });
    expect((await next).status).toBe(200);
    await expect(write).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
      retryable: false,
      details: { dispatched: true },
    });
  });

  it("returns a structured NOT_CONNECTED error instead of fake success", async () => {
    const host = new DesktopPluginBridgeHost({ token: "pair-secret", port: 0 });
    hosts.push(host);
    await host.listen();
    const bridge = new DesktopPluginFigmaBridge(host, {
      clientId: "agent-a",
      requestTimeoutMs: 30,
    });

    await expect(bridge.getSelection()).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      retryable: true,
    });
  });
});
