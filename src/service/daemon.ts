#!/usr/bin/env node

import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DesktopPluginBridgeHost,
  type HostAddress,
} from "../bridge/desktop-plugin/host.js";
import type { PairingCodeExchange } from "../bridge/desktop-plugin/http.js";
import { McpFigError } from "../errors.js";
import {
  parseServiceRequest,
  SERVICE_PROTOCOL_V1,
  type ServiceErrorCode,
  type ServiceErrorResponse,
  type ServiceHealth,
  ServiceProtocolError,
  type ServiceRequest,
  type ServiceSuccessResponse,
  serviceSessionIdentity,
} from "./protocol.js";
import {
  defaultServiceSocketPath,
  prepareServiceSocket,
  removeServiceSocket,
  type ServiceSocketIdentity,
  secureServiceSocket,
} from "./socket.js";

export interface BrokerDaemonOptions {
  token: string;
  port?: number;
  socketPath?: string;
  version: string;
  requestTimeoutMs?: number;
  sessionTtlMs?: number;
  maxWriteQueue?: number;
  exchangePairingCode?: PairingCodeExchange;
}

type ResolvedBrokerDaemonOptions = Required<
  Omit<BrokerDaemonOptions, "exchangePairingCode">
> &
  Pick<BrokerDaemonOptions, "exchangePairingCode">;

export class BrokerDaemon {
  readonly #options: ResolvedBrokerDaemonOptions;
  readonly #host: DesktopPluginBridgeHost;
  readonly #startedAt = new Date();
  readonly #sockets = new Set<Socket>();
  readonly #inflight = new Set<Promise<void>>();
  #server: Server | undefined;
  #pluginAddress: HostAddress | undefined;
  #startPromise: Promise<ServiceHealth> | undefined;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #ownsSocket = false;
  #socketIdentity: ServiceSocketIdentity | undefined;

  constructor(options: BrokerDaemonOptions) {
    if (!options.token) throw new Error("Plugin token must not be empty.");
    this.#options = {
      token: options.token,
      port: options.port ?? 3847,
      socketPath: options.socketPath ?? defaultServiceSocketPath(),
      version: options.version,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      sessionTtlMs: options.sessionTtlMs ?? 30_000,
      maxWriteQueue: options.maxWriteQueue ?? 100,
      ...(options.exchangePairingCode
        ? { exchangePairingCode: options.exchangePairingCode }
        : {}),
    };
    this.#host = new DesktopPluginBridgeHost({
      token: this.#options.token,
      port: this.#options.port,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      sessionTtlMs: this.#options.sessionTtlMs,
      maxWriteQueue: this.#options.maxWriteQueue,
      allowProxy: false,
      ...(this.#options.exchangePairingCode
        ? { exchangePairingCode: this.#options.exchangePairingCode }
        : {}),
    });
  }

  start(): Promise<ServiceHealth> {
    if (this.#closing) {
      return Promise.reject(new Error("MCP Fig service is closing."));
    }
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  health(): ServiceHealth {
    if (!this.#pluginAddress) {
      throw new Error("MCP Fig service has not started.");
    }
    return {
      protocol: SERVICE_PROTOCOL_V1,
      pid: process.pid,
      version: this.#options.version,
      startedAt: this.#startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - this.#startedAt.getTime()),
      plugin: {
        host: this.#pluginAddress.host,
        port: this.#pluginAddress.port,
      },
      sessions: this.#host.sessions().map(serviceSessionIdentity),
    };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<ServiceHealth> {
    try {
      this.#pluginAddress = await this.#host.listen();
      await prepareServiceSocket(this.#options.socketPath);
      const server = createServer((socket) => this.#accept(socket));
      this.#server = server;
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(this.#options.socketPath, resolveListen);
      });
      this.#ownsSocket = true;
      this.#socketIdentity = await secureServiceSocket(
        this.#options.socketPath,
      );
      return this.health();
    } catch (error) {
      const server = this.#server;
      this.#server = undefined;
      if (server?.listening) {
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose()),
        );
      }
      await this.#host.close().catch(() => undefined);
      if (this.#ownsSocket && this.#socketIdentity) {
        await removeServiceSocket(
          this.#options.socketPath,
          this.#socketIdentity,
        ).catch(() => undefined);
        this.#ownsSocket = false;
        this.#socketIdentity = undefined;
      }
      throw error;
    }
  }

  #accept(socket: Socket): void {
    if (this.#closing) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    const finishSocket = () => this.#sockets.delete(socket);
    socket.once("close", finishSocket);
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1_000_000) {
        handled = true;
        const task = this.#respondError(
          socket,
          "unknown",
          "INVALID_REQUEST",
          "Service request is too large.",
        );
        this.#track(task);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const task = this.#processLine(socket, buffer.slice(0, newline));
      this.#track(task);
    });
  }

  #track(task: Promise<void>): void {
    this.#inflight.add(task);
    void task.finally(() => this.#inflight.delete(task));
  }

  async #processLine(socket: Socket, line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      await this.#respondError(
        socket,
        "unknown",
        "INVALID_REQUEST",
        "Service request must be valid JSON.",
      );
      return;
    }
    const requestId =
      raw && typeof raw === "object" && "requestId" in raw
        ? String((raw as { requestId?: unknown }).requestId ?? "unknown")
        : "unknown";
    try {
      const request = parseServiceRequest(raw);
      const data = await this.#handle(request);
      const response: ServiceSuccessResponse = {
        protocol: SERVICE_PROTOCOL_V1,
        requestId: request.requestId,
        ok: true,
        data,
      };
      this.#send(socket, response);
    } catch (error) {
      if (error instanceof McpFigError) {
        await this.#respondError(
          socket,
          requestId,
          error.code,
          error.message,
          error.retryable,
          error.details,
        );
      } else if (error instanceof ServiceProtocolError) {
        await this.#respondError(socket, requestId, error.code, error.message);
      } else {
        await this.#respondError(
          socket,
          requestId,
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "Service request failed.",
        );
      }
    }
  }

  async #handle(request: ServiceRequest): Promise<unknown> {
    switch (request.method) {
      case "health":
        return this.health();
      case "status":
        return {
          daemon: this.health(),
          bridge: this.#host.status(request.params.fileKey),
        };
      case "sessions":
        return this.#host.sessions();
      case "request":
        return this.#host.request(
          request.params.clientId,
          request.params.method,
          request.params.params,
          request.params.options ?? {},
        );
    }
  }

  async #respondError(
    socket: Socket,
    requestId: string,
    code: ServiceErrorCode,
    message: string,
    retryable?: boolean,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const response: ServiceErrorResponse = {
      protocol: SERVICE_PROTOCOL_V1,
      requestId,
      ok: false,
      error: {
        code,
        message,
        ...(retryable !== undefined ? { retryable } : {}),
        ...(details ? { details } : {}),
      },
    };
    this.#send(socket, response);
  }

  #send(
    socket: Socket,
    response: ServiceSuccessResponse | ServiceErrorResponse,
  ): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }

  async #close(): Promise<void> {
    this.#closing = true;
    await this.#startPromise?.catch(() => undefined);
    const server = this.#server;
    this.#server = undefined;
    let serverClosed = Promise.resolve();
    if (server?.listening) {
      serverClosed = new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
    await this.#host.close();
    await Promise.allSettled([...this.#inflight]);
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await serverClosed;
    this.#pluginAddress = undefined;
    if (this.#ownsSocket && this.#socketIdentity) {
      await removeServiceSocket(this.#options.socketPath, this.#socketIdentity);
      this.#ownsSocket = false;
      this.#socketIdentity = undefined;
    }
  }
}

export async function runForegroundDaemon(
  options: BrokerDaemonOptions,
): Promise<void> {
  const daemon = new BrokerDaemon(options);
  let signalReceived: (() => void) | undefined;
  const stopped = new Promise<void>((resolveStop) => {
    signalReceived = resolveStop;
  });
  const stop = () => signalReceived?.();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await daemon.start();
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await daemon.close();
  }
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3847");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "MCP_FIG_PLUGIN_PORT must be an integer between 1 and 65535.",
    );
  }
  return port;
}

const directEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (directEntry) {
  const token = process.env.MCP_FIG_PLUGIN_TOKEN;
  if (!token) {
    console.error("[mcp-fig-service] MCP_FIG_PLUGIN_TOKEN is required.");
    process.exitCode = 1;
  } else {
    void runForegroundDaemon({
      token,
      port: parsePort(process.env.MCP_FIG_PLUGIN_PORT),
      socketPath:
        process.env.MCP_FIG_SERVICE_SOCKET ?? defaultServiceSocketPath(),
      version: process.env.MCP_FIG_VERSION ?? "0.0.0",
    }).catch((error: unknown) => {
      console.error(
        `[mcp-fig-service] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
  }
}
