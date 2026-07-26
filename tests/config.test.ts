import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("enables core and deduplicates optional profiles", () => {
    const config = loadConfig({
      MCP_FIG_PROFILES: "advanced,tokens,advanced",
      MCP_FIG_LOG_LEVEL: "debug",
    });

    expect(config.profiles).toEqual(["core", "advanced", "tokens"]);
    expect(config.logLevel).toBe("debug");
  });

  it("loads the optional REST connection without exposing it by default", () => {
    const config = loadConfig({
      FIGMA_ACCESS_TOKEN: "secret",
      FIGMA_FILE_KEY: "file-1",
      FIGMA_API_BASE_URL: "https://figma.test",
    });

    expect(config.figmaRest).toEqual({
      accessToken: "secret",
      fileKey: "file-1",
      baseUrl: "https://figma.test",
    });
  });

  it("uses the persistent service by default without forwarding the Plugin token", () => {
    const config = loadConfig({
      MCP_FIG_PLUGIN_TOKEN: "pair-secret",
      MCP_FIG_PLUGIN_PORT: "4938",
      MCP_FIG_PLUGIN_CLIENT_ID: "agent-a",
      MCP_FIG_PLUGIN_FILE_KEY: "file-live",
    });

    expect(config.service).toEqual({
      clientId: "agent-a",
      fileKey: "file-live",
    });
    expect(config.desktopPlugin).toBeUndefined();
  });

  it("allows the in-process host only in explicit manual mode", () => {
    const config = loadConfig({
      MCP_FIG_DESKTOP_MODE: "manual",
      MCP_FIG_PLUGIN_TOKEN: "pair-secret",
      MCP_FIG_PLUGIN_PORT: "4938",
      MCP_FIG_PLUGIN_CLIENT_ID: "agent-a",
    });

    expect(config.service).toBeUndefined();
    expect(config.desktopPlugin).toEqual({
      token: "pair-secret",
      port: 4938,
      clientId: "agent-a",
    });
  });

  it("connects to an explicit service socket without a Plugin token", () => {
    const config = loadConfig({
      MCP_FIG_DESKTOP_MODE: "service",
      MCP_FIG_SERVICE_SOCKET: "/tmp/mcp-fig-test.sock",
      MCP_FIG_PLUGIN_CLIENT_ID: "agent-b",
    });

    expect(config.service).toEqual({
      socketPath: "/tmp/mcp-fig-test.sock",
      clientId: "agent-b",
    });
  });

  it("rejects invalid Desktop Plugin ports", () => {
    expect(() =>
      loadConfig({
        MCP_FIG_PLUGIN_TOKEN: "pair-secret",
        MCP_FIG_PLUGIN_PORT: "0",
      }),
    ).toThrow("MCP_FIG_PLUGIN_PORT");
  });

  it("rejects unknown profiles", () => {
    expect(() => loadConfig({ MCP_FIG_PROFILES: "core,unknown" })).toThrow(
      "Unknown MCP Fig profile: unknown",
    );
  });
});
