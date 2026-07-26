import { describe, expect, it } from "vitest";
import { DesktopPluginFigmaBridge } from "../src/bridge/desktop-plugin/facade.js";
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
});
