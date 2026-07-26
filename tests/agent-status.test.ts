import { describe, expect, it } from "vitest";

import { buildAgentServiceStatus } from "../src/service/agent-status.js";
import { initialStartupState } from "../src/service/startup-state.js";

const baseHealth = {
  protocol: "mcp-fig-service/v1" as const,
  pid: 42,
  version: "test",
  startedAt: "2026-07-27T01:00:00.000Z",
  uptimeMs: 1_000,
  plugin: { host: "127.0.0.1" as const, port: 3847 },
  lastHandshakeAt: "2026-07-27T01:00:10.000Z",
  sessions: [
    {
      sessionId: "session-1",
      clientId: "plugin-1",
      file: { key: "file-1", name: "File One", revision: "7" },
    },
  ],
};

describe("agent-readable service status", () => {
  it("keeps stable fields when the service is not installed", () => {
    expect(
      buildAgentServiceStatus({
        launchd: { loaded: false, running: false },
        startup: initialStartupState(),
      }),
    ).toEqual({
      service: "not_installed",
      pluginSessionCount: 0,
      files: [],
      lastHandshakeAt: null,
      actionableError: {
        code: "SERVICE_NOT_INSTALLED",
        message: "MCP Fig service is not installed.",
        action: "Run `mcp-fig service install` before starting the Plugin.",
      },
      startupRunId: null,
      startupState: "idle",
      attemptsUsed: 0,
      stageStartedAt: null,
      lastProgressAt: null,
      leaseExpiresAt: null,
      lastStartupError: null,
      circuitOpenUntil: null,
      lastVerifiedPluginAt: null,
    });
  });

  it("reports a running broker without a Plugin session as actionable", () => {
    expect(
      buildAgentServiceStatus({
        launchd: { loaded: true, running: true, pid: 42 },
        daemonStatus: {
          daemon: { ...baseHealth, sessions: [], lastHandshakeAt: null },
          bridge: {
            connected: false,
            connectionState: "disconnected",
            mode: "desktop-plugin",
            readSource: "none",
            writeSource: "none",
          },
        },
        startup: initialStartupState(),
      }),
    ).toMatchObject({
      service: "running",
      pluginSessionCount: 0,
      files: [],
      lastHandshakeAt: null,
      actionableError: {
        code: "PLUGIN_NOT_CONNECTED",
        action:
          "Open Figma and run Plugins > Development > MCP Fig Live Bridge.",
      },
    });
  });

  it("surfaces a persistent startup blocker before the generic Plugin fallback", () => {
    const startup = {
      ...initialStartupState(),
      startupRunId: "blocked-run",
      startupState: "paused" as const,
      lastStartupError: {
        code: "COMPUTER_USE_SESSION_ENDED",
        message: "Startup needs explicit user action.",
        stage: "plugin-starting" as const,
        actionRequired: true,
      },
    };
    expect(
      buildAgentServiceStatus({
        launchd: { loaded: true, running: true, pid: 42 },
        daemonStatus: {
          daemon: { ...baseHealth, sessions: [], lastHandshakeAt: null },
          bridge: {
            connected: false,
            connectionState: "disconnected",
            mode: "desktop-plugin",
            readSource: "none",
            writeSource: "none",
          },
        },
        startup,
      }),
    ).toMatchObject({
      service: "running",
      pluginSessionCount: 0,
      actionableError: {
        code: "COMPUTER_USE_SESSION_ENDED",
        action:
          "Resolve the blocker, then run `mcp-fig service startup begin --explicit-retry --json`.",
      },
    });
  });

  it("lists files and clears actionableError after a handshake", () => {
    const status = buildAgentServiceStatus({
      launchd: { loaded: true, running: true, pid: 42 },
      daemonStatus: {
        daemon: baseHealth,
        bridge: {
          connected: true,
          connectionState: "ready",
          mode: "desktop-plugin",
          fileKey: "file-1",
          fileName: "File One",
          revision: "7",
          readSource: "desktop-plugin",
          writeSource: "desktop-plugin",
        },
      },
      startup: {
        ...initialStartupState(),
        startupRunId: "run-1",
        startupState: "verified",
        lastVerifiedPluginAt: "2026-07-27T01:00:10.000Z",
      },
    });
    expect(status).toMatchObject({
      service: "running",
      pluginSessionCount: 1,
      files: [
        {
          sessionId: "session-1",
          clientId: "plugin-1",
          fileKey: "file-1",
          fileName: "File One",
          revision: "7",
        },
      ],
      lastHandshakeAt: "2026-07-27T01:00:10.000Z",
      actionableError: null,
      startupRunId: "run-1",
      startupState: "verified",
    });
  });

  it("distinguishes a loaded but unavailable daemon without leaking its raw error", () => {
    expect(
      buildAgentServiceStatus({
        launchd: { loaded: true, running: true, pid: 42 },
        daemonError: new Error("socket payload credential=do-not-leak"),
        startup: initialStartupState(),
      }),
    ).toMatchObject({
      service: "unavailable",
      actionableError: {
        code: "SERVICE_UNAVAILABLE",
        message: "MCP Fig daemon did not answer its owner-only socket.",
        action: "Run `mcp-fig service restart`, then check status again.",
      },
    });
  });
});
