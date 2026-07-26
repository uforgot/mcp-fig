import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventLogger } from "../src/observability/event-log.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-fig-events-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sink() {
  let output = "";
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        output += String(chunk);
        return true;
      },
    },
    read: () => output,
  };
}

describe("observability event log", () => {
  it("writes only whitelisted redacted fields to stderr and never stdout", async () => {
    const stderr = sink();
    const stdout = sink();
    const logger = new EventLogger({
      stderr: stderr.stream,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
      daemonPid: 321,
    });

    logger.emit({
      level: "error",
      traceId: "trace-redaction",
      requestId: "request-1",
      clientId: "client-1",
      sessionId: "session-1",
      fileKey: "file-1",
      method: "node.update",
      action: "figma.api.result",
      targetNodeIds: ["2:1"],
      revision: "8",
      errorCode: "NODE_NOT_FOUND",
      latencyMs: 14,
      retryable: false,
      token: "SHOULD-NOT-APPEAR",
      authorization: "Bearer SHOULD-NOT-APPEAR",
      pairingCode: "PAIR-SECRET",
      credential: "CREDENTIAL-SECRET",
      socketPayload: { secret: "SOCKET-SECRET" },
      document: { children: ["DOCUMENT-SECRET"] },
    } as never);
    await logger.flush();

    const event = JSON.parse(stderr.read().trim()) as Record<string, unknown>;
    expect(event).toEqual({
      timestamp: "2026-07-27T00:00:00.000Z",
      level: "error",
      traceId: "trace-redaction",
      requestId: "request-1",
      clientId: "client-1",
      daemonPid: 321,
      sessionId: "session-1",
      fileKey: "file-1",
      method: "node.update",
      action: "figma.api.result",
      targetNodeIds: ["2:1"],
      revision: "8",
      errorCode: "NODE_NOT_FOUND",
      latencyMs: 14,
      retryable: false,
    });
    expect(stderr.read()).not.toMatch(
      /SHOULD-NOT-APPEAR|PAIR-SECRET|CREDENTIAL-SECRET|SOCKET-SECRET|DOCUMENT-SECRET/,
    );
    expect(stdout.read()).toBe("");
  });

  it("replaces malformed events with a safe diagnostic", async () => {
    const stderr = sink();
    const logger = new EventLogger({
      stderr: stderr.stream,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
      daemonPid: 654,
    });

    logger.emit({
      token: "MALFORMED-SECRET",
      payload: { all: "secret" },
    } as never);
    await logger.flush();

    expect(JSON.parse(stderr.read().trim())).toEqual({
      timestamp: "2026-07-27T00:00:00.000Z",
      level: "warn",
      traceId: "invalid-event",
      daemonPid: 654,
      action: "event.invalid",
      errorCode: "INVALID_EVENT",
      retryable: false,
    });
    expect(stderr.read()).not.toContain("MALFORMED-SECRET");
  });

  it("rotates an opt-in owner-only JSONL file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    const stderr = sink();
    const logger = new EventLogger({
      stderr: stderr.stream,
      jsonlPath: path,
      maxBytes: 360,
      backups: 2,
      daemonPid: 987,
    });

    for (let index = 0; index < 20; index += 1) {
      logger.emit({
        level: "info",
        traceId: `trace-${index}`,
        requestId: `request-${index}`,
        action: "dispatch",
      });
    }
    await logger.flush();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toMatch(/"action":"dispatch"/);
    expect(await readFile(`${path}.1`, "utf8")).toMatch(/"traceId":"trace-/);
    await expect(stat(`${path}.3`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
