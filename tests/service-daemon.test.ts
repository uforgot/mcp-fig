import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceClient } from "../src/service/client.js";
import { BrokerDaemon } from "../src/service/daemon.js";
import { SERVICE_PROTOCOL_V1 } from "../src/service/protocol.js";

const daemons: BrokerDaemon[] = [];
const tempDirectories: string[] = [];

async function temporarySocket(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-fig-service-"));
  tempDirectories.push(directory);
  return join(directory, "service.sock");
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function pair(
  port: number,
  token: string,
  sessionId: string,
  fileKey: string,
): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/session/handshake`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "mcp-fig-plugin/v1",
        sessionId,
        clientId: "test-plugin-ui",
        file: { key: fileKey, name: "Service test", revision: "1" },
        capabilities: ["selection.read", "node.write"],
        sentAt: new Date().toISOString(),
      }),
    },
  );
  expect(response.status).toBe(200);
}

describe("persistent broker service", () => {
  it("reports an unavailable daemon without starting an in-process host", async () => {
    const client = new ServiceClient({ socketPath: await temporarySocket() });
    await expect(client.health()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    await expect(
      client.request("reader", "selection.get", {}, { fileKey: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED", retryable: true });
    await expect(
      client.request(
        "writer",
        "node.update",
        { nodeIds: ["2:1"], patch: { name: "unsafe" } },
        { fileKey: "missing" },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME", retryable: false });
  });

  it("recovers a stale owner socket and enforces 0600 permissions", async () => {
    const socketPath = await temporarySocket();
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const net=require('node:net');const s=net.createServer();s.listen(process.argv[1],()=>process.exit(0));",
        socketPath,
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`stale socket child ${code}`)),
      );
    });
    expect((await stat(socketPath)).isSocket()).toBe(true);

    const daemon = new BrokerDaemon({
      token: "stale-test-token",
      port: 0,
      socketPath,
      version: "test",
    });
    daemons.push(daemon);
    const health = await daemon.start();
    await pair(
      health.plugin.port,
      "stale-test-token",
      "status-session",
      "status-file",
    );

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const client = new ServiceClient({ socketPath });
    await expect(client.health()).resolves.toMatchObject({
      protocol: SERVICE_PROTOCOL_V1,
      version: "test",
    });
    await expect(client.status("status-file")).resolves.toMatchObject({
      daemon: {
        pid: process.pid,
        version: "test",
        startedAt: expect.any(String),
        uptimeMs: expect.any(Number),
        sessions: [
          {
            sessionId: "status-session",
            file: { key: "status-file", name: "Service test", revision: "1" },
          },
        ],
      },
      bridge: { connected: true, fileKey: "status-file" },
    });
  });

  it("rejects a protocol mismatch from an owner-only socket", async () => {
    const socketPath = await temporarySocket();
    const accepted = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      accepted.add(socket);
      socket.once("close", () => accepted.delete(socket));
      socket.end(
        `${JSON.stringify({
          protocol: "mcp-fig-service/v0",
          requestId: "wrong",
          ok: true,
          data: {},
        })}\n`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o644);
    try {
      const client = new ServiceClient({ socketPath });
      await expect(client.health()).rejects.toMatchObject({
        code: "SOCKET_NOT_OWNER_ONLY",
      });
      await chmod(socketPath, 0o600);
      await expect(client.health()).rejects.toMatchObject({
        code: "PROTOCOL_MISMATCH",
      });
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("isolates concurrent clients behind one daemon owner", async () => {
    const socketPath = await temporarySocket();
    const daemon = new BrokerDaemon({
      token: "concurrency-test-token",
      port: 0,
      socketPath,
      version: "test",
    });
    daemons.push(daemon);
    const started = await daemon.start();

    const secondDaemon = new BrokerDaemon({
      token: "second-owner-token",
      port: 0,
      socketPath,
      version: "test",
    });
    daemons.push(secondDaemon);
    await expect(secondDaemon.start()).rejects.toMatchObject({
      code: "SOCKET_IN_USE",
    });

    const health = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        new ServiceClient({
          socketPath,
          clientId: `agent-${index}`,
        }).health(),
      ),
    );
    expect(new Set(health.map((item) => item.pid))).toEqual(
      new Set([process.pid]),
    );
    expect(new Set(health.map((item) => item.plugin.port))).toEqual(
      new Set([started.plugin.port]),
    );
    expect(health.every((item) => item.sessions.length === 0)).toBe(true);
  });

  it("returns safe outcomes when shutdown interrupts pending read and write", async () => {
    const readSocket = await temporarySocket();
    const readDaemon = new BrokerDaemon({
      token: "read-shutdown-token",
      port: 0,
      socketPath: readSocket,
      version: "test",
    });
    daemons.push(readDaemon);
    const readHealth = await readDaemon.start();
    await pair(
      readHealth.plugin.port,
      "read-shutdown-token",
      "read-session",
      "read-file",
    );
    const readClient = new ServiceClient({ socketPath: readSocket });
    const pendingRead = readClient.request(
      "reader",
      "selection.get",
      {},
      { fileKey: "read-file", timeoutMs: 5_000 },
    );
    const readRejected = expect(pendingRead).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await readDaemon.close();
    await readRejected;
    daemons.splice(daemons.indexOf(readDaemon), 1);

    const writeSocket = await temporarySocket();
    const writeDaemon = new BrokerDaemon({
      token: "write-shutdown-token",
      port: 0,
      socketPath: writeSocket,
      version: "test",
    });
    daemons.push(writeDaemon);
    const writeHealth = await writeDaemon.start();
    await pair(
      writeHealth.plugin.port,
      "write-shutdown-token",
      "write-session",
      "write-file",
    );
    const next = fetch(
      `http://127.0.0.1:${writeHealth.plugin.port}/v1/session/write-session/next`,
      { headers: { authorization: "Bearer write-shutdown-token" } },
    );
    const writeClient = new ServiceClient({ socketPath: writeSocket });
    const pendingWrite = writeClient.request(
      "writer",
      "node.update",
      {
        nodeIds: ["2:1"],
        patch: { name: "pending" },
        idempotencyKey: "pending-write",
      },
      { fileKey: "write-file", timeoutMs: 5_000 },
    );
    const writeRejected = expect(pendingWrite).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
    });
    const dispatched = await next;
    expect(dispatched.status).toBe(200);
    await writeDaemon.close();
    await writeRejected;
    daemons.splice(daemons.indexOf(writeDaemon), 1);
  });
});
