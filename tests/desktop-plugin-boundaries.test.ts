import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  type DesktopPluginBridgeTransport,
  DesktopPluginFigmaBridge,
} from "../src/bridge/desktop-plugin/facade.js";
import { DesktopPluginBridgeHost } from "../src/bridge/desktop-plugin/host.js";
import { PluginSessionRegistry } from "../src/bridge/desktop-plugin/sessions.js";
import { PluginWriteCoordinator } from "../src/bridge/desktop-plugin/write-coordinator.js";
import {
  DesktopPluginFigmaBridge as CompatibilityFacade,
  DesktopPluginBridgeHost as CompatibilityHost,
} from "../src/bridge/desktop-plugin.js";
import type { PluginHandshake } from "../src/bridge/plugin-protocol.js";

const sendJson = () => undefined;

describe("Desktop Plugin service-ready module boundaries", () => {
  it("keeps the compatibility entry mapped to the extracted host and facade", () => {
    expect(CompatibilityHost).toBe(DesktopPluginBridgeHost);
    expect(CompatibilityFacade).toBe(DesktopPluginFigmaBridge);
  });

  it("constructs session and write state owners independently of HTTP lifecycle", () => {
    const sessions = new PluginSessionRegistry(30_000);
    const coordinator = new PluginWriteCoordinator({
      sessions,
      requestTimeoutMs: 1_000,
      maxWriteQueue: 10,
      sendJson,
    });

    expect(sessions.list()).toEqual([]);
    expect(coordinator.metrics()).toEqual([]);
    coordinator.close();
  });

  it("keeps the newest same-file session authoritative until it becomes stale", () => {
    const sessions = new PluginSessionRegistry(30_000);
    const handshake = (sessionId: string): PluginHandshake => ({
      protocol: "mcp-fig-plugin/v1" as const,
      sessionId,
      clientId: `plugin:${sessionId}`,
      file: { key: "local:file-a", name: "File A", revision: "1" },
      capabilities: ["selection.read"],
      sentAt: new Date().toISOString(),
    });

    const oldSession = sessions.acceptHandshake(handshake("old")).session;
    if (!oldSession) throw new Error("Expected old Plugin session.");
    let waiterEndCount = 0;
    let waiterEnded = false;
    const waiter = {
      get writableEnded() {
        return waiterEnded;
      },
      end() {
        waiterEnded = true;
        waiterEndCount += 1;
      },
    } as unknown as ServerResponse;
    oldSession.waiters.push(waiter);

    const newSession = sessions.acceptHandshake(handshake("new")).session;
    if (!newSession)
      throw new Error("Expected new Plugin session to be accepted.");
    expect(waiterEndCount).toBe(1);
    expect(oldSession.waiters).toHaveLength(0);
    expect(oldSession.state).toBe("superseded");
    expect(sessions.touch(oldSession)).toBe(false);
    expect(sessions.list().map((item) => item.sessionId)).toEqual(["new"]);

    oldSession.lastSeenMs = 0;
    expect(sessions.acceptHandshake(handshake("old"))).toMatchObject({
      conflict: false,
      superseded: true,
    });
    expect(sessions.get("old")?.state).toBe("superseded");
    expect(sessions.list().map((item) => item.sessionId)).toEqual(["new"]);

    newSession.lastSeenMs = 0;
    expect(sessions.acceptHandshake(handshake("old"))).toMatchObject({
      conflict: false,
      session: { state: "ready" },
    });
    expect(sessions.get("new")).toBeUndefined();
    expect(sessions.list().map((item) => item.sessionId)).toEqual(["old"]);
  });

  it("exports multiple nodes through separate Plugin RPC responses", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const transport: DesktopPluginBridgeTransport = {
      async close() {},
      async statusAsync() {
        return {
          connected: true,
          mode: "desktop-plugin",
          fileKey: "file-1",
          readSource: "desktop-plugin",
          writeSource: "desktop-plugin",
        };
      },
      async sessionsAsync() {
        return [];
      },
      async waitForSession() {
        throw new Error("not expected");
      },
      async request(_clientId, method, params) {
        calls.push({ method, params });
        const input = params as { nodeIds: string[]; format: "PNG" };
        return input.nodeIds.map((nodeId) => ({
          nodeId,
          nodeName: nodeId,
          format: input.format,
          mimeType: "image/png",
          byteLength: 8,
          dataBase64: "iVBORw0KGgo=",
        }));
      },
    };
    const bridge = new DesktopPluginFigmaBridge(transport, {
      clientId: "agent-a",
      fileKey: "file-1",
    });

    await expect(
      bridge.exportNodes({
        nodeIds: ["28:26", "28:27"],
        format: "PNG",
        scale: 1,
        fileKey: "file-1",
      }),
    ).resolves.toHaveLength(2);
    expect(calls).toEqual([
      {
        method: "node.export",
        params: { nodeIds: ["28:26"], format: "PNG", scale: 1 },
      },
      {
        method: "node.export",
        params: { nodeIds: ["28:27"], format: "PNG", scale: 1 },
      },
    ]);
  });

  it("stops per-node export RPCs after a mid-batch failure", async () => {
    const nodeIds: string[] = [];
    const transport: DesktopPluginBridgeTransport = {
      async close() {},
      async statusAsync() {
        return {
          connected: true,
          mode: "desktop-plugin",
          readSource: "desktop-plugin",
          writeSource: "desktop-plugin",
        };
      },
      async sessionsAsync() {
        return [];
      },
      async waitForSession() {
        throw new Error("not expected");
      },
      async request(_clientId: string, _method: string, params: unknown) {
        const [nodeId] = (params as { nodeIds: string[] }).nodeIds;
        if (!nodeId) throw new Error("missing node id");
        nodeIds.push(nodeId);
        if (nodeId === "2:2") throw new Error("export failed");
        return [
          {
            nodeId,
            nodeName: nodeId,
            format: "PNG",
            mimeType: "image/png",
            byteLength: 8,
            dataBase64: "iVBORw0KGgo=",
          },
        ];
      },
    };
    const bridge = new DesktopPluginFigmaBridge(transport, {
      clientId: "agent-a",
    });

    await expect(
      bridge.exportNodes({
        nodeIds: ["2:1", "2:2", "2:3"],
        format: "PNG",
        scale: 1,
      }),
    ).rejects.toThrow("export failed");
    expect(nodeIds).toEqual(["2:1", "2:2"]);
  });
});
