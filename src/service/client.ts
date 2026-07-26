import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { isReadOnlyRequest } from "../bridge/desktop-plugin/write-coordinator.js";
import type { PluginHandshake } from "../bridge/plugin-protocol.js";
import type { BridgeStatus } from "../bridge/types.js";
import { type ErrorCode, McpFigError } from "../errors.js";
import { traceIdOrCreate } from "../observability/trace-context.js";
import {
  parseServiceResponse,
  SERVICE_PROTOCOL_V1,
  type ServiceHealth,
  type ServiceMethod,
  ServiceProtocolError,
  type ServiceRequestParams,
  type ServiceStatus,
} from "./protocol.js";
import {
  defaultServiceSocketPath,
  ServiceSocketError,
  verifyServiceSocket,
} from "./socket.js";

export interface ServiceClientOptions {
  socketPath?: string;
  clientId?: string;
  requestTimeoutMs?: number;
}

export class ServiceClientError extends Error {
  readonly code:
    | "SERVICE_UNAVAILABLE"
    | "SERVICE_TIMEOUT"
    | "PROTOCOL_MISMATCH"
    | "INVALID_RESPONSE"
    | "INVALID_REQUEST"
    | "SOCKET_NOT_OWNER_ONLY";
  readonly dispatched: boolean;

  constructor(
    code: ServiceClientError["code"],
    message: string,
    dispatched = false,
  ) {
    super(message);
    this.name = "ServiceClientError";
    this.code = code;
    this.dispatched = dispatched;
  }
}

const BRIDGE_ERROR_CODES = new Set<ErrorCode>([
  "INVALID_ARGUMENT",
  "NOT_CONNECTED",
  "UNKNOWN_OUTCOME",
  "FILE_NOT_TARGETED",
  "FILE_NOT_FOUND",
  "NODE_NOT_FOUND",
  "REVISION_CONFLICT",
  "BUSY",
  "CONFIRMATION_REQUIRED",
  "UNSUPPORTED_BY_BRIDGE",
  "INTERNAL_ERROR",
]);

interface ServiceResultMap {
  health: ServiceHealth;
  status: ServiceStatus;
  sessions: PluginHandshake[];
  request: unknown;
}

export class ServiceClient {
  readonly #socketPath: string;
  readonly #clientId: string;
  readonly #requestTimeoutMs: number;

  constructor(options: ServiceClientOptions = {}) {
    this.#socketPath = options.socketPath ?? defaultServiceSocketPath();
    this.#clientId = options.clientId ?? `mcp-fig-${process.pid}`;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async close(): Promise<void> {
    // Requests use isolated short-lived connections. Closing a client must not stop the daemon.
  }

  health(): Promise<ServiceHealth> {
    return this.#call("health", {});
  }

  status(fileKey?: string): Promise<ServiceStatus> {
    return this.#call("status", fileKey ? { fileKey } : {});
  }

  async statusAsync(fileKey?: string): Promise<BridgeStatus> {
    return (await this.status(fileKey)).bridge;
  }

  sessionsAsync(): Promise<PluginHandshake[]> {
    return this.#call("sessions", {});
  }

  async request(
    clientId: string,
    method: string,
    params: unknown,
    options: { fileKey?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    try {
      return await this.#call(
        "request",
        {
          clientId: clientId || this.#clientId,
          method,
          params,
          options,
        },
        (options.timeoutMs ?? this.#requestTimeoutMs) + 1_000,
      );
    } catch (error) {
      if (
        !(error instanceof ServiceClientError) ||
        ![
          "SERVICE_UNAVAILABLE",
          "SERVICE_TIMEOUT",
          "PROTOCOL_MISMATCH",
          "INVALID_RESPONSE",
        ].includes(error.code)
      ) {
        throw error;
      }
      if (isReadOnlyRequest(method, params)) {
        throw new McpFigError("NOT_CONNECTED", error.message, {
          retryable: true,
          details: {
            serviceCode: error.code,
            dispatched: error.dispatched,
          },
        });
      }
      throw new McpFigError("UNKNOWN_OUTCOME", error.message, {
        retryable: false,
        details: { serviceCode: error.code, dispatched: error.dispatched },
      });
    }
  }

  async waitForSession(
    fileKey: string,
    timeoutMs = 5_000,
  ): Promise<PluginHandshake> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const session = (await this.sessionsAsync()).find(
        (candidate) => candidate.file.key === fileKey,
      );
      if (session) return session;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new McpFigError(
      "NOT_CONNECTED",
      `Desktop Plugin did not pair file ${fileKey}.`,
      { retryable: true, details: { fileKey, dispatched: false } },
    );
  }

  async #call<Method extends ServiceMethod>(
    method: Method,
    params: ServiceRequestParams[Method],
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<ServiceResultMap[Method]> {
    const requestId = randomUUID();
    const traceId = traceIdOrCreate();
    try {
      await verifyServiceSocket(this.#socketPath);
    } catch (error) {
      if (error instanceof ServiceSocketError) {
        throw new ServiceClientError(
          error.code === "SOCKET_NOT_OWNER_ONLY"
            ? "SOCKET_NOT_OWNER_ONLY"
            : "SERVICE_UNAVAILABLE",
          error.message,
        );
      }
      throw error;
    }
    const response = await this.#exchange(
      JSON.stringify({
        protocol: SERVICE_PROTOCOL_V1,
        traceId,
        requestId,
        method,
        params,
      }),
      requestId,
      traceId,
      timeoutMs,
    );
    if (!response.ok) {
      if (BRIDGE_ERROR_CODES.has(response.error.code as ErrorCode)) {
        throw new McpFigError(
          response.error.code as ErrorCode,
          response.error.message,
          {
            ...(response.error.retryable !== undefined
              ? { retryable: response.error.retryable }
              : {}),
            ...(response.error.details
              ? { details: response.error.details }
              : {}),
          },
        );
      }
      throw new ServiceClientError(
        response.error.code === "PROTOCOL_MISMATCH"
          ? "PROTOCOL_MISMATCH"
          : response.error.code === "INVALID_REQUEST"
            ? "INVALID_REQUEST"
            : "SERVICE_UNAVAILABLE",
        response.error.message,
        true,
      );
    }
    return response.data as ServiceResultMap[Method];
  }

  #exchange(
    payload: string,
    requestId: string,
    traceId: string,
    timeoutMs: number,
  ): Promise<ReturnType<typeof parseServiceResponse>> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.#socketPath);
      let buffer = "";
      let settled = false;
      let dispatched = false;
      const finish = (
        error?: unknown,
        value?: ReturnType<typeof parseServiceResponse>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const timer = setTimeout(() => {
        finish(
          new ServiceClientError(
            "SERVICE_TIMEOUT",
            `MCP Fig service request timed out after ${timeoutMs}ms.`,
            dispatched,
          ),
        );
      }, timeoutMs);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        dispatched = true;
        socket.write(`${payload}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1_000_000) {
          finish(
            new ServiceClientError(
              "INVALID_RESPONSE",
              "MCP Fig service response is too large.",
            ),
          );
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const value = JSON.parse(buffer.slice(0, newline)) as unknown;
          finish(undefined, parseServiceResponse(value, requestId, traceId));
        } catch (error) {
          if (error instanceof ServiceProtocolError) {
            finish(
              new ServiceClientError(
                error.code === "PROTOCOL_MISMATCH"
                  ? "PROTOCOL_MISMATCH"
                  : "INVALID_RESPONSE",
                error.message,
                dispatched,
              ),
            );
          } else {
            finish(
              new ServiceClientError(
                "INVALID_RESPONSE",
                "MCP Fig service response is not valid JSON.",
                dispatched,
              ),
            );
          }
        }
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        finish(
          new ServiceClientError(
            "SERVICE_UNAVAILABLE",
            `MCP Fig service is unavailable: ${error.code ?? error.message}.`,
            dispatched,
          ),
        );
      });
      socket.once("end", () => {
        if (!settled) {
          finish(
            new ServiceClientError(
              "SERVICE_UNAVAILABLE",
              "MCP Fig service closed without a response.",
              dispatched,
            ),
          );
        }
      });
    });
  }
}
