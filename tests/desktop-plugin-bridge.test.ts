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
import { PLUGIN_PROTOCOL_V1 } from "../src/bridge/plugin-protocol.js";
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
  let revision = 7;

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
        revision += 1;
        const params = command.params as { patch?: { name?: string } };
        data = [
          {
            id: "2:1",
            type: "RECTANGLE",
            name: params.patch?.name ?? "Updated live node",
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
        revision: String(revision),
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
  it("exchanges one-time pairing codes only for localhost/null origins", async () => {
    const credential = "p".repeat(43);
    const consumed = new Set<string>();
    const seen: string[] = [];
    const host = new DesktopPluginBridgeHost({
      token: credential,
      port: 0,
      exchangePairingCode: async (code: string) => {
        seen.push(code);
        if (code === "EXPIRED") {
          return {
            ok: false as const,
            code: "PAIRING_EXPIRED" as const,
            message: "Pairing code expired.",
          };
        }
        if (code !== "VALID-CODE" && code !== "LOCAL-CODE") {
          return {
            ok: false as const,
            code: "PAIRING_INVALID" as const,
            message: "Invalid pairing code.",
          };
        }
        if (consumed.has(code)) {
          return {
            ok: false as const,
            code: "PAIRING_USED" as const,
            message: "Pairing code was already used.",
          };
        }
        consumed.add(code);
        return { ok: true as const, credential };
      },
    });
    hosts.push(host);
    const address = await host.listen();
    const exchange = (code: string, origin: string | null = "null") =>
      fetch(`${address.url}/v1/pair/exchange`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin === null ? {} : { origin }),
        },
        body: JSON.stringify({ protocol: PLUGIN_PROTOCOL_V1, code }),
      });

    const forbidden = await exchange("VALID-CODE", "https://attacker.example");
    expect(forbidden.status).toBe(403);
    expect(seen).toEqual([]);

    const missingOrigin = await exchange("VALID-CODE", null);
    expect(missingOrigin.status).toBe(403);
    expect(seen).toEqual([]);

    const paired = await exchange("VALID-CODE");
    expect(paired.status).toBe(200);
    expect(await paired.json()).toEqual({
      protocol: PLUGIN_PROTOCOL_V1,
      credential,
    });
    expect(paired.headers.get("cache-control")).toBe("no-store");
    expect(paired.headers.get("access-control-allow-origin")).toBe("null");

    const replay = await exchange("VALID-CODE");
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: { code: "PAIRING_USED" },
    });

    const expired = await exchange("EXPIRED");
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({
      error: { code: "PAIRING_EXPIRED" },
    });

    const invalid = await exchange("WRONG");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "PAIRING_INVALID" },
    });

    const localOrigin = await exchange(
      "LOCAL-CODE",
      `http://localhost:${address.port}`,
    );
    expect(localOrigin.status).toBe(200);

    const mismatch = await fetch(`${address.url}/v1/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ protocol: "mcp-fig-plugin/v0", code: "VALID" }),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "PROTOCOL_MISMATCH" },
    });
  });

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

  it("skips an aborted long-poll waiter and dispatches to the next live waiter", async () => {
    const host = new DesktopPluginBridgeHost({
      token: "waiter-secret",
      port: 0,
      requestTimeoutMs: 1_000,
    });
    hosts.push(host);
    const address = await host.listen();
    await json(`${address.url}/v1/session/handshake`, {
      method: "POST",
      headers: {
        authorization: "Bearer waiter-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: PLUGIN_PROTOCOL_V1,
        sessionId: "waiter-session",
        clientId: "figma-plugin-ui",
        file: { key: "waiter-file", name: "Waiter file", revision: "1" },
        capabilities: ["selection.read"],
        sentAt: new Date().toISOString(),
      }),
    });

    const stale = new AbortController();
    const stalePoll = fetch(`${address.url}/v1/session/waiter-session/next`, {
      headers: { authorization: "Bearer waiter-secret" },
      signal: stale.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stale.abort();
    await stalePoll;

    const livePoll = fetch(`${address.url}/v1/session/waiter-session/next`, {
      headers: { authorization: "Bearer waiter-secret" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const request = host.request(
      "agent-waiter",
      "selection.get",
      {},
      { fileKey: "waiter-file" },
    );
    const response = await livePoll;
    expect(response.status).toBe(200);
    const command = (await response.json()) as PluginCommand;
    expect(command.method).toBe("selection.get");

    const result: PluginResult = {
      protocol: PLUGIN_PROTOCOL_V1,
      requestId: command.requestId,
      clientId: command.clientId,
      sessionId: command.sessionId,
      fileKey: command.fileKey,
      ok: true,
      revision: "1",
      data: [],
      pluginReceivedAt: command.dispatchedAt,
      receivedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    await json(`${address.url}/v1/session/waiter-session/result`, {
      method: "POST",
      headers: {
        authorization: "Bearer waiter-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(result),
    });
    await expect(request).resolves.toEqual([]);
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

  it("shares one broker across hosts that bind the same port", async () => {
    const primary = new DesktopPluginBridgeHost({
      token: "pair-secret",
      port: 0,
    });
    hosts.push(primary);
    const address = await primary.listen();
    startFakePlugin(address.url, "pair-secret");
    await primary.waitForSession("file-live", 1_000);

    const secondary = new DesktopPluginBridgeHost({
      token: "pair-secret",
      port: address.port,
    });
    const tertiary = new DesktopPluginBridgeHost({
      token: "pair-secret",
      port: address.port,
    });
    hosts.push(secondary, tertiary);
    await Promise.all([secondary.listen(), tertiary.listen()]);

    const secondaryBridge = new DesktopPluginFigmaBridge(secondary, {
      clientId: "secondary-process",
    });
    await expect(secondaryBridge.status()).resolves.toMatchObject({
      connected: true,
      fileKey: "file-live",
    });
    await expect(secondaryBridge.listFiles()).resolves.toContainEqual({
      key: "file-live",
      name: "Live file",
      revision: "7",
    });

    const params = {
      nodeIds: ["2:1"],
      patch: { name: "Shared broker" },
      idempotencyKey: "shared-broker-nonce",
    };
    const [left, right] = await Promise.all([
      secondary.request("secondary-process", "node.update", params, {
        fileKey: "file-live",
      }),
      tertiary.request("tertiary-process", "node.update", params, {
        fileKey: "file-live",
      }),
    ]);
    expect(left).toEqual(right);
    expect(
      primary.metrics().filter((metric) => metric.method === "node.update"),
    ).toHaveLength(1);

    await secondary.close();
    await expect(
      primary.request(
        "primary-process",
        "selection.get",
        {},
        {
          fileKey: "file-live",
        },
      ),
    ).resolves.toEqual(["2:1"]);
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

    const staleUpdate = await call(client, "figma_node", {
      action: "update",
      nodeIds: ["2:1"],
      patch: { name: "Must not overwrite" },
      fileKey: "file-live",
      expectedRevision: "7",
      idempotencyKey: "stale-mcp-write",
    });
    expect(staleUpdate.result.isError).toBe(true);
    expect(staleUpdate.payload.error).toMatchObject({
      code: "REVISION_CONFLICT",
      retryable: true,
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

  it("rejects the loser when concurrent writes share an expected revision", async () => {
    const host = new DesktopPluginBridgeHost({ token: "pair-secret", port: 0 });
    hosts.push(host);
    const address = await host.listen();
    startFakePlugin(address.url, "pair-secret");
    await host.waitForSession("file-live", 1_000);

    const writes = ["agent-a", "agent-b"].map((clientId) =>
      host.request(
        clientId,
        "node.update",
        {
          nodeIds: ["2:1"],
          patch: { name: clientId },
          expectedRevision: "7",
          idempotencyKey: `write-${clientId}`,
        },
        { fileKey: "file-live" },
      ),
    );
    const results = await Promise.allSettled(writes);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "REVISION_CONFLICT", retryable: true },
    });
  });

  it("deduplicates concurrent retries with the same idempotency key", async () => {
    const host = new DesktopPluginBridgeHost({ token: "pair-secret", port: 0 });
    hosts.push(host);
    const address = await host.listen();
    startFakePlugin(address.url, "pair-secret");
    await host.waitForSession("file-live", 1_000);
    const params = {
      nodeIds: ["2:1"],
      patch: { name: "once" },
      idempotencyKey: "same-write",
    };

    const [first, retry] = await Promise.all([
      host.request("agent-a", "node.update", params, { fileKey: "file-live" }),
      host.request("agent-a", "node.update", params, { fileKey: "file-live" }),
    ]);

    expect(retry).toEqual(first);
    expect(
      host
        .metrics()
        .filter(
          (metric) =>
            metric.clientId === "agent-a" && metric.method === "node.update",
        ),
    ).toHaveLength(1);
  });

  it("deduplicates equivalent retries despite object key order", async () => {
    const host = new DesktopPluginBridgeHost({ token: "pair-secret", port: 0 });
    hosts.push(host);
    const address = await host.listen();
    startFakePlugin(address.url, "pair-secret");
    await host.waitForSession("file-live", 1_000);

    const first = await host.request(
      "client-a",
      "node.update",
      {
        nodeIds: ["2:1"],
        patch: { name: "Canonical" },
        idempotencyKey: "canonical-retry",
      },
      { fileKey: "file-live" },
    );
    const second = await host.request(
      "client-b",
      "node.update",
      {
        idempotencyKey: "canonical-retry",
        patch: { name: "Canonical" },
        nodeIds: ["2:1"],
      },
      { fileKey: "file-live" },
    );

    expect(second).toEqual(first);
    expect(
      host.metrics().filter((metric) => metric.method === "node.update"),
    ).toHaveLength(1);
  });

  it("returns BUSY when the per-file write queue is full", async () => {
    const host = new DesktopPluginBridgeHost({
      token: "pair-secret",
      port: 0,
      requestTimeoutMs: 30,
      maxWriteQueue: 1,
    });
    hosts.push(host);
    const address = await host.listen();
    const paired = await fetch(`${address.url}/v1/session/handshake`, {
      method: "POST",
      headers: {
        authorization: "Bearer pair-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: PLUGIN_PROTOCOL_V1,
        pluginVersion: "0.0.0-test",
        sessionId: "busy-session",
        clientId: "busy-plugin",
        file: { key: "file-busy", name: "Busy file", revision: "1" },
        capabilities: ["node.write"],
        sentAt: new Date().toISOString(),
      }),
    });
    expect(paired.status).toBe(200);

    const first = host.request(
      "client-a",
      "node.update",
      { nodeIds: ["2:1"], patch: { name: "Queued" } },
      { fileKey: "file-busy" },
    );
    await expect(
      host.request(
        "client-b",
        "node.update",
        { nodeIds: ["2:1"], patch: { name: "Overflow" } },
        { fileKey: "file-busy" },
      ),
    ).rejects.toMatchObject({ code: "BUSY", retryable: true });
    await expect(first).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it.each([2, 5, 10])(
    "keeps %i concurrent agent responses isolated",
    async (agentCount) => {
      const host = new DesktopPluginBridgeHost({
        token: "pair-secret",
        port: 0,
      });
      hosts.push(host);
      const address = await host.listen();
      startFakePlugin(address.url, "pair-secret");
      await host.waitForSession("file-live", 1_000);

      const results = await Promise.all(
        Array.from({ length: agentCount }, (_, index) => {
          const clientId = `agent-${index}`;
          return host.request(
            clientId,
            "node.update",
            {
              nodeIds: [`2:${index + 1}`],
              patch: { name: clientId },
              idempotencyKey: `isolated-${agentCount}-${index}`,
            },
            { fileKey: "file-live" },
          );
        }),
      );

      expect(results).toHaveLength(agentCount);
      results.forEach((result, index) => {
        expect(result).toEqual([
          expect.objectContaining({ name: `agent-${index}` }),
        ]);
      });
      const metrics = host
        .metrics()
        .filter((metric) => metric.method === "node.update")
        .slice(-agentCount);
      expect(new Set(metrics.map((metric) => metric.requestId)).size).toBe(
        agentCount,
      );
      expect(new Set(metrics.map((metric) => metric.clientId)).size).toBe(
        agentCount,
      );
    },
  );

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
