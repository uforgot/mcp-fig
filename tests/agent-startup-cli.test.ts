import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runServiceCli } from "../src/service/cli.js";
import {
  readCredential,
  readOrCreateCredential,
} from "../src/service/credential.js";
import { BrokerDaemon } from "../src/service/daemon.js";
import type { LaunchctlRunner } from "../src/service/launchd.js";
import {
  ensureServiceDirectories,
  servicePaths,
  writeServiceConfig,
} from "../src/service/paths.js";

const homes: string[] = [];
const daemons: BrokerDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mcp-fig-agent-startup-"));
  homes.push(path);
  return path;
}

const runningLaunchd: LaunchctlRunner = async (args) => {
  if (args[0] === "print") {
    return { code: 0, stdout: "state = running\npid = 4321\n", stderr: "" };
  }
  throw new Error(`Unexpected launchctl call: ${args.join(" ")}`);
};

describe("agent startup CLI", () => {
  it("persists state and returns stable status fields around a real Plugin handshake", async () => {
    const root = await home();
    const paths = servicePaths({ home: root });
    await ensureServiceDirectories(paths);
    const credential = await readOrCreateCredential(paths);
    const socketPath = join(tmpdir(), `mfa-${root.slice(-8)}.sock`);
    const daemon = new BrokerDaemon({
      token: credential.pluginToken,
      port: 0,
      socketPath,
      version: "agent-startup-test",
    });
    daemons.push(daemon);
    const health = await daemon.start();
    await writeServiceConfig(paths, {
      version: 1,
      serviceVersion: "agent-startup-test",
      port: health.plugin.port,
      socketPath,
    });
    const output: string[] = [];
    const options = {
      home: root,
      launchctl: runningLaunchd,
      now: () => Date.parse("2026-07-27T02:00:00.000Z"),
      stdout: (line: string) => output.push(line),
      stderr: () => undefined,
    };

    expect(await runServiceCli(["startup", "begin"], options)).toBe(0);
    expect(
      await runServiceCli(["startup", "stage", "plugin-starting"], options),
    ).toBe(0);
    expect((await stat(paths.startupStatePath)).mode & 0o777).toBe(0o600);

    output.length = 0;
    expect(await runServiceCli(["status", "--json"], options)).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      service: "running",
      pluginSessionCount: 0,
      files: [],
      lastHandshakeAt: null,
      actionableError: { code: "PLUGIN_NOT_CONNECTED" },
      startupState: "plugin-starting",
      attemptsUsed: 0,
    });
    await expect(
      runServiceCli(["startup", "verify", "--json"], options),
    ).rejects.toThrow("without an active Plugin session");

    const handshake = await fetch(
      `http://127.0.0.1:${health.plugin.port}/v1/session/handshake`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.pluginToken}`,
          "content-type": "application/json",
          origin: "null",
        },
        body: JSON.stringify({
          protocol: "mcp-fig-plugin/v1",
          traceId: "agent-startup-trace",
          sessionId: "agent-session",
          clientId: "agent-plugin",
          file: { key: "agent-file", name: "Agent File", revision: "3" },
          capabilities: ["document.read", "selection.read", "node.read"],
          sentAt: "2026-07-27T02:00:00.000Z",
        }),
      },
    );
    expect(handshake.status).toBe(200);

    output.length = 0;
    expect(await runServiceCli(["status", "--json"], options)).toBe(0);
    const verified = JSON.parse(output.at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(verified).toMatchObject({
      service: "running",
      pluginSessionCount: 1,
      files: [
        {
          sessionId: "agent-session",
          clientId: "agent-plugin",
          fileKey: "agent-file",
          fileName: "Agent File",
          revision: "3",
        },
      ],
      lastHandshakeAt: expect.any(String),
      actionableError: null,
      startupState: "verified",
      attemptsUsed: 0,
      lastVerifiedPluginAt: "2026-07-27T02:00:00.000Z",
    });
    expect(JSON.stringify(verified)).not.toContain(credential.pluginToken);
  });

  it("records an adapter blocker without stopping the daemon or rotating credentials", async () => {
    const root = await home();
    const paths = servicePaths({ home: root });
    await ensureServiceDirectories(paths);
    const before = await readOrCreateCredential(paths);
    const socketPath = join(tmpdir(), `mfa-${root.slice(-8)}.sock`);
    const daemon = new BrokerDaemon({
      token: before.pluginToken,
      port: 0,
      socketPath,
      version: "adapter-failure-test",
    });
    daemons.push(daemon);
    await daemon.start();
    const output: string[] = [];
    const options = {
      home: root,
      now: () => 1_000,
      stdout: (line: string) => output.push(line),
      stderr: () => undefined,
    };

    await runServiceCli(["startup", "begin"], options);
    await runServiceCli(["startup", "stage", "plugin-locating"], options);
    await runServiceCli(
      [
        "startup",
        "action",
        "plugin-locating",
        "computer-use-capture",
        "background",
        "blocked",
        "COMPUTER_USE_SESSION_ENDED",
        "--json",
      ],
      options,
    );

    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      startupState: "paused",
      attemptsUsed: 0,
      lastStartupError: {
        code: "COMPUTER_USE_SESSION_ENDED",
        actionRequired: true,
      },
    });
    expect(() => daemon.health()).not.toThrow();
    expect((await readCredential(paths)).pluginToken).toBe(before.pluginToken);
  });
});
