import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { type ErrorCode, McpFigError } from "../errors.js";
import {
  PLUGIN_PROTOCOL_V1,
  type PluginCapability,
  type PluginCommand,
  type PluginHandshake,
  type PluginMetric,
  type PluginResult,
  parseHandshake,
  parseResult,
} from "./plugin-protocol.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  ComponentActionInput,
  CreateNodeInput,
  DeleteNodesInput,
  FigmaBridge,
  FigmaDocumentSummary,
  FigmaFileSummary,
  FigmaNode,
  InstanceActionInput,
  LayoutActionInput,
  MoveNodesInput,
  ResizeNodesInput,
  TokenActionInput,
  UpdateNodesInput,
} from "./types.js";

interface HostOptions {
  token: string;
  port?: number;
  requestTimeoutMs?: number;
  sessionTtlMs?: number;
}

interface HostAddress {
  host: "127.0.0.1";
  port: number;
  url: string;
}

interface SessionState {
  handshake: PluginHandshake;
  connectedAt: string;
  lastSeenAt: string;
  lastSeenMs: number;
  state: "ready" | "reconnecting" | "disconnected";
  queue: PluginCommand[];
  waiters: ServerResponse[];
}

interface PendingRequest {
  command: PluginCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  dispatched: boolean;
  readOnly: boolean;
}

const ERROR_CODES = new Set<ErrorCode>([
  "INVALID_ARGUMENT",
  "NOT_CONNECTED",
  "UNKNOWN_OUTCOME",
  "FILE_NOT_TARGETED",
  "FILE_NOT_FOUND",
  "NODE_NOT_FOUND",
  "REVISION_CONFLICT",
  "CONFIRMATION_REQUIRED",
  "UNSUPPORTED_BY_BRIDGE",
  "INTERNAL_ERROR",
]);

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000)
      throw new McpFigError(
        "INVALID_ARGUMENT",
        "Protocol payload is too large.",
      );
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Protocol payload must be valid JSON.",
    );
  }
}

function equalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function duration(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function requiredCapability(method: string): PluginCapability {
  if (method.startsWith("document.") || method === "changes.get")
    return "document.read";
  if (method === "selection.get") return "selection.read";
  if (method === "node.get") return "node.read";
  if (method.startsWith("node.")) return "node.write";
  if (method === "layout") return "layout.write";
  if (method === "component") return "component.write";
  if (method === "instance") return "instance.write";
  if (method === "tokens") return "tokens.write";
  throw new McpFigError(
    "UNSUPPORTED_BY_BRIDGE",
    `Unknown Desktop Plugin method ${method}.`,
  );
}

function isReadOnlyRequest(method: string, params: unknown): boolean {
  if (
    method.startsWith("document.") ||
    method === "selection.get" ||
    method === "changes.get" ||
    method === "node.get"
  )
    return true;
  const action =
    params && typeof params === "object" && "action" in params
      ? (params as { action?: unknown }).action
      : undefined;
  return ["inspect", "search", "validate"].includes(String(action));
}

export class DesktopPluginBridgeHost {
  readonly #options: Required<HostOptions>;
  readonly #sessions = new Map<string, SessionState>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #metrics: PluginMetric[] = [];
  #server: Server | undefined;
  #address: HostAddress | undefined;

  constructor(options: HostOptions) {
    if (!options.token)
      throw new Error("Desktop Plugin session token must not be empty.");
    this.#options = {
      token: options.token,
      port: options.port ?? 3847,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      sessionTtlMs: options.sessionTtlMs ?? 30_000,
    };
  }

  async listen(): Promise<HostAddress> {
    if (this.#address) return this.#address;
    this.#server = createServer((request, response) => {
      void this.#route(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.#options.port, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === "string")
      throw new Error("Desktop Plugin host did not bind a TCP port.");
    this.#address = {
      host: "127.0.0.1",
      port: address.port,
      url: `http://127.0.0.1:${address.port}`,
    };
    return this.#address;
  }

  async close(): Promise<void> {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new McpFigError("NOT_CONNECTED", "Desktop Plugin bridge closed.", {
          retryable: true,
        }),
      );
    }
    this.#pending.clear();
    for (const session of this.#sessions.values()) {
      for (const waiter of session.waiters) {
        if (!waiter.writableEnded) waiter.end();
      }
    }
    this.#sessions.clear();
    if (this.#server) {
      await new Promise<void>((resolve, reject) =>
        this.#server?.close((error) => (error ? reject(error) : resolve())),
      );
    }
    this.#server = undefined;
    this.#address = undefined;
  }

  metrics(): PluginMetric[] {
    return this.#metrics.map((metric) => ({ ...metric }));
  }

  sessions(): PluginHandshake[] {
    this.#expireSessions();
    return [...this.#sessions.values()]
      .filter((session) => session.state === "ready")
      .map((session) => structuredClone(session.handshake));
  }

  async waitForSession(
    fileKey: string,
    timeoutMs = 5_000,
  ): Promise<PluginHandshake> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const session = this.#sessionForFile(fileKey);
      if (session) return structuredClone(session.handshake);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new McpFigError(
      "NOT_CONNECTED",
      `Desktop Plugin did not pair file ${fileKey}.`,
      { retryable: true },
    );
  }

  status(fileKey?: string): BridgeStatus {
    this.#expireSessions();
    const session = fileKey
      ? this.#sessionForFile(fileKey)
      : this.#latestSession();
    if (!session) {
      return {
        connected: false,
        connectionState: "disconnected",
        mode: "desktop-plugin",
        readSource: "none",
        writeSource: "none",
      };
    }
    return {
      connected: true,
      connectionState: session.state,
      lastHeartbeatAt: session.lastSeenAt,
      mode: "desktop-plugin",
      fileKey: session.handshake.file.key,
      fileName: session.handshake.file.name,
      revision: session.handshake.file.revision,
      readSource: "desktop-plugin",
      writeSource: "desktop-plugin",
    };
  }

  async request(
    clientId: string,
    method: string,
    params: unknown,
    options: { fileKey?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    this.#expireSessions();
    const session = options.fileKey
      ? this.#sessionForFile(options.fileKey)
      : this.#latestSession();
    if (!session) {
      const hasOtherFile = options.fileKey && this.#latestSession();
      throw new McpFigError(
        hasOtherFile ? "FILE_NOT_TARGETED" : "NOT_CONNECTED",
        hasOtherFile
          ? `No paired Desktop Plugin session targets file ${options.fileKey}.`
          : "No active Figma Desktop Plugin session is paired.",
        {
          retryable: true,
          ...(options.fileKey ? { details: { fileKey: options.fileKey } } : {}),
        },
      );
    }
    const capability = requiredCapability(method);
    if (!session.handshake.capabilities.includes(capability)) {
      throw new McpFigError(
        "UNSUPPORTED_BY_BRIDGE",
        `Paired Desktop Plugin does not advertise ${capability}.`,
        {
          details: {
            method,
            capability,
            sessionId: session.handshake.sessionId,
            fileKey: session.handshake.file.key,
          },
        },
      );
    }
    const now = new Date().toISOString();
    const command: PluginCommand = {
      protocol: PLUGIN_PROTOCOL_V1,
      requestId: randomUUID(),
      clientId,
      sessionId: session.handshake.sessionId,
      fileKey: session.handshake.file.key,
      method,
      params,
      createdAt: now,
      dispatchedAt: now,
    };
    const readOnly = isReadOnlyRequest(method, params);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(command.requestId);
        this.#pending.delete(command.requestId);
        const queuedIndex = session.queue.findIndex(
          (queued) => queued.requestId === command.requestId,
        );
        if (queuedIndex >= 0) session.queue.splice(queuedIndex, 1);
        const unknownWriteOutcome = pending?.dispatched && !pending.readOnly;
        reject(
          new McpFigError(
            unknownWriteOutcome ? "UNKNOWN_OUTCOME" : "NOT_CONNECTED",
            unknownWriteOutcome
              ? `Desktop Plugin write ${command.requestId} timed out after dispatch; its outcome is unknown and it was not retried.`
              : `Desktop Plugin request ${command.requestId} timed out before completion.`,
            {
              retryable: !unknownWriteOutcome,
              details: {
                requestId: command.requestId,
                sessionId: command.sessionId,
                fileKey: command.fileKey,
                dispatched: pending?.dispatched ?? false,
              },
            },
          ),
        );
      }, options.timeoutMs ?? this.#options.requestTimeoutMs);
      this.#pending.set(command.requestId, {
        command,
        resolve,
        reject,
        timeout,
        dispatched: false,
        readOnly,
      });
      const waiter = session.waiters.shift();
      if (waiter && !waiter.writableEnded) {
        const pending = this.#pending.get(command.requestId);
        if (pending) pending.dispatched = true;
        writeJson(waiter, 200, command);
      } else session.queue.push(command);
    });
  }

  async #route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("access-control-allow-origin", "null");
    response.setHeader(
      "access-control-allow-headers",
      "authorization, content-type",
    );
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!this.#authorized(request, url)) {
        writeJson(response, 401, {
          error: { code: "UNAUTHORIZED", message: "Invalid session token." },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/metrics") {
        writeJson(response, 200, {
          protocol: PLUGIN_PROTOCOL_V1,
          metrics: this.metrics(),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/session/handshake"
      ) {
        const handshake = parseHandshake(await readJson(request));
        const existing = this.#sessions.get(handshake.sessionId);
        if (
          existing &&
          (existing.handshake.clientId !== handshake.clientId ||
            existing.handshake.file.key !== handshake.file.key)
        ) {
          writeJson(response, 409, {
            error: {
              code: "SESSION_CONFLICT",
              message: "Session identity changed.",
            },
          });
          return;
        }
        const now = new Date().toISOString();
        this.#sessions.set(handshake.sessionId, {
          handshake,
          connectedAt: existing?.connectedAt ?? now,
          lastSeenAt: now,
          lastSeenMs: Date.now(),
          state: "ready",
          queue: existing?.queue ?? [],
          waiters: existing?.waiters ?? [],
        });
        writeJson(response, 200, {
          protocol: PLUGIN_PROTOCOL_V1,
          accepted: true,
          sessionId: handshake.sessionId,
          fileKey: handshake.file.key,
          serverTime: now,
        });
        return;
      }
      const match = /^\/v1\/session\/([^/]+)\/(next|result|heartbeat)$/.exec(
        url.pathname,
      );
      if (!match) {
        writeJson(response, 404, {
          error: { code: "NOT_FOUND", message: "Unknown bridge route." },
        });
        return;
      }
      const sessionId = decodeURIComponent(match[1] ?? "");
      const action = match[2];
      const session = this.#sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, {
          error: { code: "SESSION_NOT_FOUND", message: "Pair again." },
        });
        return;
      }
      session.lastSeenAt = new Date().toISOString();
      session.lastSeenMs = Date.now();
      session.state = "ready";
      if (request.method === "GET" && action === "next") {
        const command = session.queue.shift();
        if (command) {
          command.dispatchedAt = new Date().toISOString();
          const pending = this.#pending.get(command.requestId);
          if (pending) pending.dispatched = true;
          writeJson(response, 200, command);
          return;
        }
        session.waiters.push(response);
        const timer = setTimeout(() => {
          const index = session.waiters.indexOf(response);
          if (index >= 0) session.waiters.splice(index, 1);
          if (!response.writableEnded) {
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();
          }
        }, 1_000);
        response.once("close", () => clearTimeout(timer));
        return;
      }
      if (request.method === "POST" && action === "heartbeat") {
        writeJson(response, 200, {
          ok: true,
          sessionId,
          serverTime: session.lastSeenAt,
        });
        return;
      }
      if (request.method === "POST" && action === "result") {
        const result = parseResult(await readJson(request));
        const responseCompletedAt = new Date().toISOString();
        const pending = this.#pending.get(result.requestId);
        if (
          !pending ||
          pending.command.clientId !== result.clientId ||
          pending.command.sessionId !== result.sessionId ||
          pending.command.fileKey !== result.fileKey ||
          result.sessionId !== sessionId
        ) {
          writeJson(response, 409, {
            error: {
              code: "CORRELATION_MISMATCH",
              message: "Result does not match a pending request target.",
            },
          });
          return;
        }
        this.#pending.delete(result.requestId);
        clearTimeout(pending.timeout);
        if (result.revision) session.handshake.file.revision = result.revision;
        this.#recordMetric(pending.command, result, responseCompletedAt);
        if (result.ok) pending.resolve(result.data);
        else {
          const code =
            result.error && ERROR_CODES.has(result.error.code as ErrorCode)
              ? (result.error.code as ErrorCode)
              : "INTERNAL_ERROR";
          pending.reject(
            new McpFigError(
              code,
              result.error?.message ?? "Desktop Plugin command failed.",
              {
                ...(result.error?.retryable !== undefined
                  ? { retryable: result.error.retryable }
                  : {}),
                details: {
                  requestId: result.requestId,
                  sessionId: result.sessionId,
                  fileKey: result.fileKey,
                  ...(result.error?.details ?? {}),
                },
              },
            ),
          );
        }
        writeJson(response, 200, {
          accepted: true,
          requestId: result.requestId,
        });
        return;
      }
      writeJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
      });
    } catch (error) {
      const figmaError =
        error instanceof McpFigError
          ? error
          : new McpFigError("INTERNAL_ERROR", String(error));
      writeJson(response, figmaError.code === "INVALID_ARGUMENT" ? 400 : 500, {
        error: { code: figmaError.code, message: figmaError.message },
      });
    }
  }

  #authorized(request: IncomingMessage, _url: URL): boolean {
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    return equalToken(bearer, this.#options.token);
  }

  #recordMetric(
    command: PluginCommand,
    result: PluginResult,
    responseCompletedAt: string,
  ): void {
    const pluginReceivedAt = result.pluginReceivedAt ?? result.receivedAt;
    const figmaApiStartedAt = result.figmaApiStartedAt ?? pluginReceivedAt;
    const figmaApiCompletedAt =
      result.figmaApiCompletedAt ?? result.completedAt;
    this.#metrics.push({
      requestId: command.requestId,
      clientId: command.clientId,
      sessionId: command.sessionId,
      fileKey: command.fileKey,
      method: command.method,
      createdAt: command.createdAt,
      dispatchedAt: command.dispatchedAt,
      receivedAt: result.receivedAt,
      completedAt: result.completedAt,
      serverReceivedAt: command.createdAt,
      bridgeSentAt: command.dispatchedAt,
      pluginReceivedAt,
      figmaApiStartedAt,
      figmaApiCompletedAt,
      responseCompletedAt,
      queueMs: duration(command.createdAt, command.dispatchedAt),
      requestTransportMs: duration(command.dispatchedAt, pluginReceivedAt),
      figmaApiMs: duration(figmaApiStartedAt, figmaApiCompletedAt),
      responseTransportMs: duration(figmaApiCompletedAt, responseCompletedAt),
      pluginMs: duration(result.receivedAt, result.completedAt),
      totalMs: duration(command.createdAt, responseCompletedAt),
      requestBytes: Buffer.byteLength(JSON.stringify(command)),
      responseBytes: Buffer.byteLength(JSON.stringify(result)),
      sceneTraversalNodeCount: result.sceneTraversalNodeCount ?? 0,
      ok: result.ok,
    });
    if (this.#metrics.length > 1_000)
      this.#metrics.splice(0, this.#metrics.length - 1_000);
  }

  #expireSessions(): void {
    const now = Date.now();
    for (const session of this.#sessions.values()) {
      if (now - session.lastSeenMs > this.#options.sessionTtlMs)
        session.state = "disconnected";
    }
  }

  #sessionForFile(fileKey: string): SessionState | undefined {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          session.state === "ready" && session.handshake.file.key === fileKey,
      )
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)[0];
  }

  #latestSession(): SessionState | undefined {
    return [...this.#sessions.values()]
      .filter((session) => session.state === "ready")
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)[0];
  }
}

interface BridgeOptions {
  clientId: string;
  requestTimeoutMs?: number;
  fileKey?: string;
}

export class DesktopPluginFigmaBridge implements FigmaBridge {
  readonly #host: DesktopPluginBridgeHost;
  readonly #clientId: string;
  readonly #requestTimeoutMs: number;
  #targetFileKey: string | undefined;

  constructor(host: DesktopPluginBridgeHost, options: BridgeOptions) {
    this.#host = host;
    this.#clientId = options.clientId;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#targetFileKey = options.fileKey;
  }

  async status(): Promise<BridgeStatus> {
    return this.#host.status(this.#targetFileKey);
  }

  async listFiles(): Promise<FigmaFileSummary[]> {
    return this.#host.sessions().map((session) => ({
      key: session.file.key,
      name: session.file.name,
      revision: session.file.revision,
    }));
  }

  async targetFile(fileKey: string): Promise<BridgeStatus> {
    const status = this.#host.status(fileKey);
    if (!status.connected) {
      throw new McpFigError(
        "FILE_NOT_FOUND",
        `No paired Desktop Plugin session for file ${fileKey}.`,
        {
          retryable: true,
        },
      );
    }
    this.#targetFileKey = fileKey;
    return status;
  }

  async reconnect(): Promise<BridgeStatus> {
    return this.status();
  }

  async getDocument(fileKey?: string): Promise<FigmaNode> {
    return this.#rpc("document.get", {}, fileKey) as Promise<FigmaNode>;
  }

  async getDocumentSummary(fileKey?: string): Promise<FigmaDocumentSummary> {
    return this.#rpc(
      "document.summary",
      {},
      fileKey,
    ) as Promise<FigmaDocumentSummary>;
  }

  async getSelection(fileKey?: string): Promise<string[]> {
    return this.#rpc("selection.get", {}, fileKey) as Promise<string[]>;
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    return this.#rpc("changes.get", {}, fileKey) as Promise<ChangeRecord[]>;
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    return this.#rpc("node.get", { nodeIds }, fileKey) as Promise<FigmaNode[]>;
  }

  async createNode(input: CreateNodeInput): Promise<FigmaNode[]> {
    return this.#rpc("node.create", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.update", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async moveNodes(input: MoveNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.move", input, input.fileKey) as Promise<FigmaNode[]>;
  }

  async resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.resize", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.clone", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async deleteNodes(input: DeleteNodesInput): Promise<string[]> {
    return this.#rpc("node.delete", input, input.fileKey) as Promise<string[]>;
  }

  async layout(input: LayoutActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("layout", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async component(
    input: ComponentActionInput,
  ): Promise<Record<string, unknown>> {
    return this.#rpc("component", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async instance(input: InstanceActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("instance", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async tokens(input: TokenActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("tokens", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async #rpc(
    method: string,
    params: unknown,
    fileKey?: string,
  ): Promise<unknown> {
    const resolvedFileKey = fileKey ?? this.#targetFileKey;
    const request = () =>
      this.#host.request(this.#clientId, method, params, {
        ...(resolvedFileKey ? { fileKey: resolvedFileKey } : {}),
        timeoutMs: this.#requestTimeoutMs,
      });
    try {
      return await request();
    } catch (error) {
      if (
        !isReadOnlyRequest(method, params) ||
        !resolvedFileKey ||
        !(error instanceof McpFigError) ||
        error.code !== "NOT_CONNECTED"
      )
        throw error;
      await this.#host.waitForSession(resolvedFileKey, 3_000);
      return request();
    }
  }
}
