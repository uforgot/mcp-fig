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
