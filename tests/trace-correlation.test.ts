import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateBugReport } from "../scripts/bug-report.mjs";
import type { PluginCommand } from "../src/bridge/plugin-protocol.js";
import {
  type EventInput,
  EventLogger,
  type EventSink,
} from "../src/observability/event-log.js";
import { runWithTrace } from "../src/observability/trace-context.js";
import { ServiceClient } from "../src/service/client.js";
import { BrokerDaemon } from "../src/service/daemon.js";

class MemoryEvents implements EventSink {
  readonly events: EventInput[] = [];
  emit(event: EventInput): void {
    this.events.push(structuredClone(event));
  }
}

class CompositeEvents implements EventSink {
  constructor(readonly sinks: EventSink[]) {}

  emit(event: EventInput): void {
    for (const sink of this.sinks) sink.emit(event);
  }
}

const daemons: BrokerDaemon[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-fig-trace-"));
  directories.push(directory);
  return join(directory, "service.sock");
}

function headers(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function handshake(port: number, token: string) {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/session/handshake`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        protocol: "mcp-fig-plugin/v1",
        traceId: "trace-plugin-session",
        sessionId: "trace-session",
        clientId: "trace-plugin-ui",
        file: { key: "trace-file", name: "Trace file", revision: "4" },
        capabilities: ["selection.read", "node.write"],
        sentAt: new Date().toISOString(),
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function nextCommand(
  port: number,
  token: string,
): Promise<PluginCommand> {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/session/trace-session/next`,
    { headers: headers(token) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as PluginCommand;
}

async function result(
  port: number,
  token: string,
  command: PluginCommand,
  ok = true,
) {
  const started = new Date().toISOString();
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/session/trace-session/result`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        protocol: "mcp-fig-plugin/v1",
        traceId: command.traceId,
        requestId: command.requestId,
        clientId: command.clientId,
        sessionId: command.sessionId,
        fileKey: command.fileKey,
        ok,
        revision: "5",
        ...(ok
          ? { data: ["2:1"] }
          : {
              error: {
                code: "NODE_NOT_FOUND",
                message: "Focused fixture fault.",
                retryable: false,
              },
            }),
        receivedAt: started,
        pluginReceivedAt: started,
        figmaApiStartedAt: started,
        figmaApiCompletedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
    },
  );
  expect(response.status).toBe(200);
}

describe("daemon to Figma trace correlation", () => {
  it("keeps one trace across IPC, waiter, dispatch, and Figma API result", async () => {
    const events = new MemoryEvents();
    const token = "trace-token";
    const path = await socketPath();
    const daemon = new BrokerDaemon({
      token,
      port: 0,
      socketPath: path,
      version: "trace-test",
      eventLog: events,
    });
    daemons.push(daemon);
    const health = await daemon.start();
    await handshake(health.plugin.port, token);
    const waiting = nextCommand(health.plugin.port, token);
    const client = new ServiceClient({ socketPath: path });

    const operation = runWithTrace("trace-dogfood", () =>
      client.request(
        "trace-agent",
        "selection.get",
        {},
        { fileKey: "trace-file" },
      ),
    );
    const command = await waiting;
    expect(command.traceId).toBe("trace-dogfood");
    await result(health.plugin.port, token, command);
    await expect(operation).resolves.toEqual(["2:1"]);

    const chain = events.events.filter(
      (event) => event.traceId === "trace-dogfood",
    );
    expect(chain.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "ipc.connect",
        "waiter.close",
        "dispatch",
        "figma.api.result",
        "service.request",
        "ipc.disconnect",
      ]),
    );
    expect(
      chain.find((event) => event.action === "figma.api.result"),
    ).toMatchObject({
      requestId: command.requestId,
      clientId: "trace-agent",
      sessionId: "trace-session",
      fileKey: "trace-file",
      method: "selection.get",
      revision: "5",
      latencyMs: expect.any(Number),
    });
  });

  it("records a dispatched write interrupted by daemon shutdown once as unknown", async () => {
    const events = new MemoryEvents();
    const token = "restart-trace-token";
    const path = await socketPath();
    const eventPath = join(dirname(path), "events.jsonl");
    const eventFile = new EventLogger({
      stderr: { write: () => true },
      jsonlPath: eventPath,
    });
    const daemon = new BrokerDaemon({
      token,
      port: 0,
      socketPath: path,
      version: "trace-test",
      eventLog: new CompositeEvents([events, eventFile]),
    });
    daemons.push(daemon);
    const health = await daemon.start();
    await handshake(health.plugin.port, token);
    const waiting = nextCommand(health.plugin.port, token);
    const client = new ServiceClient({ socketPath: path });
    const operation = runWithTrace("trace-restart-fault", () =>
      client.request(
        "trace-writer",
        "node.update",
        { nodeIds: ["2:1"], patch: { name: "Maybe applied" } },
        { fileKey: "trace-file", timeoutMs: 5_000 },
      ),
    );
    const command = await waiting;
    expect(command.traceId).toBe("trace-restart-fault");

    const rejected = expect(operation).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
      retryable: false,
    });
    await daemon.close();
    daemons.splice(daemons.indexOf(daemon), 1);
    await rejected;
    const unknown = events.events.filter(
      (event) =>
        event.traceId === "trace-restart-fault" &&
        event.action === "unknown_outcome",
    );
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(unknown.every((event) => event.retryable === false)).toBe(true);
    expect(
      events.events.filter(
        (event) =>
          event.traceId === "trace-restart-fault" &&
          event.action === "dispatch",
      ),
    ).toHaveLength(1);
    await eventFile.flush();
    const reportPath = await generateBugReport({
      trace: "trace-restart-fault",
      log: eventPath,
      outputDir: join(dirname(path), "bugs"),
      date: "2026-07-27",
    });
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("UNKNOWN_OUTCOME");
    expect(report).toContain("unknown_outcome");
    expect(report).not.toContain(token);
    expect(report).not.toContain("Maybe applied");
  });
});
