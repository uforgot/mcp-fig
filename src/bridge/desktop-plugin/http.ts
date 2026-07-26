import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ErrorCode, McpFigError } from "../../errors.js";
import {
  PLUGIN_PROTOCOL_V1,
  type PluginMetric,
  type PluginResult,
  parseHandshake,
  parseResult,
} from "../plugin-protocol.js";
import type { BridgeStatus } from "../types.js";
import type { PluginSessionRegistry } from "./sessions.js";
import type { PluginWriteCoordinator } from "./write-coordinator.js";

export interface HostAddress {
  host: "127.0.0.1";
  port: number;
  url: string;
}

export type PairingExchangeErrorCode =
  | "PAIRING_INVALID"
  | "PAIRING_EXPIRED"
  | "PAIRING_USED";

export type PairingExchangeResult =
  | { ok: true; credential: string }
  | { ok: false; code: PairingExchangeErrorCode; message: string };

export type PairingCodeExchange = (
  code: string,
) => Promise<PairingExchangeResult>;

export interface PluginHttpRouterOptions {
  token: string;
  sessions: PluginSessionRegistry;
  coordinator: PluginWriteCoordinator;
  status: (fileKey?: string) => BridgeStatus;
  request: (
    clientId: string,
    method: string,
    params: unknown,
    options: { fileKey?: string; timeoutMs?: number },
  ) => Promise<unknown>;
  metrics: () => PluginMetric[];
  exchangePairingCode?: PairingCodeExchange;
}

export function writeJson(
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

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        "Protocol payload is too large.",
      );
    }
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

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function isAllowedPairingOrigin(origin: string | undefined): boolean {
  if (origin === "null") return true;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

export async function requestBrokerJson<Value>(
  address: HostAddress,
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<Value> {
  let response: globalThis.Response;
  try {
    response = await fetch(`${address.url}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  } catch (error) {
    throw new McpFigError(
      "NOT_CONNECTED",
      `Desktop Plugin broker at ${address.url} is unavailable.`,
      { retryable: true, details: { cause: String(error) } },
    );
  }
  const payload = (await response.json()) as {
    error?: {
      code?: ErrorCode;
      message?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    };
  } & Value;
  if (!response.ok) {
    throw new McpFigError(
      payload.error?.code ?? "INTERNAL_ERROR",
      payload.error?.message ??
        `Broker request failed with ${response.status}.`,
      {
        ...(payload.error?.retryable !== undefined
          ? { retryable: payload.error.retryable }
          : {}),
        ...(payload.error?.details ? { details: payload.error.details } : {}),
      },
    );
  }
  return payload;
}

export class PluginHttpRouter {
  readonly #token: string;
  readonly #sessions: PluginSessionRegistry;
  readonly #coordinator: PluginWriteCoordinator;
  readonly #status: PluginHttpRouterOptions["status"];
  readonly #request: PluginHttpRouterOptions["request"];
  readonly #metrics: PluginHttpRouterOptions["metrics"];
  readonly #exchangePairingCode: PairingCodeExchange | undefined;

  constructor(options: PluginHttpRouterOptions) {
    this.#token = options.token;
    this.#sessions = options.sessions;
    this.#coordinator = options.coordinator;
    this.#status = options.status;
    this.#request = options.request;
    this.#metrics = options.metrics;
    this.#exchangePairingCode = options.exchangePairingCode;
  }

  async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pairingRoute = url.pathname === "/v1/pair/exchange";
    const origin = request.headers.origin;
    const pairingRequestAllowed =
      isLoopbackAddress(request.socket.remoteAddress) &&
      isAllowedPairingOrigin(origin);
    response.setHeader(
      "access-control-allow-origin",
      pairingRoute && pairingRequestAllowed ? (origin ?? "null") : "null",
    );
    response.setHeader("vary", "Origin");
    response.setHeader(
      "access-control-allow-headers",
      "authorization, content-type",
    );
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      if (pairingRoute && !pairingRequestAllowed) {
        writeJson(response, 403, {
          error: {
            code: "PAIRING_ORIGIN_FORBIDDEN",
            message: "Pairing is restricted to localhost Plugin origins.",
          },
        });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      if (request.method === "POST" && pairingRoute) {
        await this.#handlePairing(request, response, pairingRequestAllowed);
        return;
      }
      if (!this.#authorized(request)) {
        writeJson(response, 401, {
          error: { code: "UNAUTHORIZED", message: "Invalid session token." },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/broker/health") {
        writeJson(response, 200, { protocol: PLUGIN_PROTOCOL_V1, ready: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/broker/sessions") {
        writeJson(response, 200, { sessions: this.#sessions.list() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/broker/status") {
        writeJson(response, 200, {
          status: this.#status(url.searchParams.get("fileKey") ?? undefined),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/broker/request") {
        const body = (await readJson(request)) as {
          clientId?: unknown;
          method?: unknown;
          params?: unknown;
          options?: { fileKey?: unknown; timeoutMs?: unknown };
        };
        if (
          typeof body.clientId !== "string" ||
          typeof body.method !== "string"
        ) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            "Broker request requires clientId and method strings.",
          );
        }
        const options = body.options ?? {};
        if (
          (options.fileKey !== undefined &&
            typeof options.fileKey !== "string") ||
          (options.timeoutMs !== undefined &&
            typeof options.timeoutMs !== "number")
        ) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            "Broker request options are invalid.",
          );
        }
        const data = await this.#request(
          body.clientId,
          body.method,
          body.params,
          options as { fileKey?: string; timeoutMs?: number },
        );
        writeJson(response, 200, { data });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/metrics") {
        writeJson(response, 200, {
          protocol: PLUGIN_PROTOCOL_V1,
          metrics: this.#metrics(),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/session/handshake"
      ) {
        this.#handleHandshake(
          response,
          parseHandshake(await readJson(request)),
        );
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
      this.#sessions.touch(session);
      if (request.method === "GET" && action === "next") {
        this.#handleNext(request, response, sessionId);
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
        this.#handleResult(response, sessionId, result);
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
        error: {
          code: figmaError.code,
          message: figmaError.message,
          retryable: figmaError.retryable,
          details: figmaError.details,
        },
      });
    }
  }

  async #handlePairing(
    request: IncomingMessage,
    response: ServerResponse,
    allowed: boolean,
  ): Promise<void> {
    if (!allowed) {
      writeJson(response, 403, {
        error: {
          code: "PAIRING_ORIGIN_FORBIDDEN",
          message: "Pairing is restricted to localhost Plugin origins.",
        },
      });
      return;
    }
    if (!this.#exchangePairingCode) {
      writeJson(response, 404, {
        error: {
          code: "PAIRING_UNAVAILABLE",
          message: "This bridge does not support service pairing.",
        },
      });
      return;
    }
    const body = (await readJson(request)) as {
      protocol?: unknown;
      code?: unknown;
    };
    if (body.protocol !== PLUGIN_PROTOCOL_V1) {
      writeJson(response, 409, {
        error: {
          code: "PROTOCOL_MISMATCH",
          message: `Plugin protocol must be ${PLUGIN_PROTOCOL_V1}.`,
        },
      });
      return;
    }
    if (
      typeof body.code !== "string" ||
      body.code.length < 6 ||
      body.code.length > 128
    ) {
      writeJson(response, 400, {
        error: {
          code: "PAIRING_INVALID",
          message: "Pairing code is invalid.",
        },
      });
      return;
    }
    const result = await this.#exchangePairingCode(body.code);
    if (!result.ok) {
      const status =
        result.code === "PAIRING_EXPIRED"
          ? 410
          : result.code === "PAIRING_USED"
            ? 409
            : 400;
      writeJson(response, status, {
        error: { code: result.code, message: result.message },
      });
      return;
    }
    writeJson(response, 200, {
      protocol: PLUGIN_PROTOCOL_V1,
      credential: result.credential,
    });
  }

  #authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    return equalToken(bearer, this.#token);
  }

  #handleHandshake(
    response: ServerResponse,
    handshake: ReturnType<typeof parseHandshake>,
  ): void {
    const accepted = this.#sessions.acceptHandshake(handshake);
    if (accepted.conflict) {
      writeJson(response, 409, {
        error: {
          code: "SESSION_CONFLICT",
          message: "Session identity changed.",
        },
      });
      return;
    }
    writeJson(response, 200, {
      protocol: PLUGIN_PROTOCOL_V1,
      accepted: true,
      sessionId: handshake.sessionId,
      fileKey: handshake.file.key,
      serverTime: accepted.now,
    });
  }

  #handleNext(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
  ): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const command = session.queue.shift();
    if (command) {
      command.dispatchedAt = new Date().toISOString();
      this.#coordinator.markDispatched(command);
      writeJson(response, 200, command);
      return;
    }
    const removeWaiter = () => {
      const index = session.waiters.indexOf(response);
      if (index >= 0) session.waiters.splice(index, 1);
    };
    session.waiters.push(response);
    const timer = setTimeout(() => {
      removeWaiter();
      if (!response.writableEnded && !response.destroyed) {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      }
    }, 1_000);
    response.once("close", () => {
      clearTimeout(timer);
      removeWaiter();
    });
    request.once("aborted", () => {
      clearTimeout(timer);
      removeWaiter();
    });
  }

  #handleResult(
    response: ServerResponse,
    sessionId: string,
    result: PluginResult,
  ): void {
    if (
      !this.#coordinator.acceptResult(
        sessionId,
        result,
        new Date().toISOString(),
      )
    ) {
      writeJson(response, 409, {
        error: {
          code: "CORRELATION_MISMATCH",
          message: "Result does not match a pending request target.",
        },
      });
      return;
    }
    writeJson(response, 200, {
      accepted: true,
      requestId: result.requestId,
    });
  }
}
