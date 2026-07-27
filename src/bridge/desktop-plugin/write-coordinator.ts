import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import { type ErrorCode, McpFigError } from "../../errors.js";
import type { EventSink } from "../../observability/event-log.js";
import {
  PLUGIN_PROTOCOL_V1,
  type PluginCapability,
  type PluginCommand,
  type PluginMetric,
  type PluginResult,
} from "../plugin-protocol.js";
import type { PluginSessionRegistry, PluginSessionState } from "./sessions.js";

interface PendingRequest {
  command: PluginCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  dispatched: boolean;
  readOnly: boolean;
}

interface WriteMetadata {
  expectedRevision?: string;
  idempotencyKey?: string;
  targetNodeIds: string[];
}

interface IdempotencyEntry {
  fingerprint: string;
  promise: Promise<unknown>;
  settled: boolean;
}

export interface PluginWriteCoordinatorOptions {
  sessions: PluginSessionRegistry;
  requestTimeoutMs: number;
  maxWriteQueue: number;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  eventLog?: EventSink;
}

export interface PluginRequestOptions {
  fileKey?: string;
  timeoutMs?: number;
  traceId?: string;
}

const ERROR_CODES = new Set<ErrorCode>([
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
  "LIBRARY_SEARCH_UNAVAILABLE",
  "LIBRARY_IMPORT_FAILED",
  "SLOT_NOT_FOUND",
  "INTERNAL_ERROR",
]);

function duration(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function requiredCapability(method: string): PluginCapability {
  if (method.startsWith("document.") || method === "changes.get") {
    return "document.read";
  }
  if (method === "selection.get") return "selection.read";
  if (
    method === "node.get" ||
    method === "node.query" ||
    method === "node.export"
  )
    return "node.read";
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

export function isReadOnlyRequest(method: string, params: unknown): boolean {
  if (
    method.startsWith("document.") ||
    method === "selection.get" ||
    method === "changes.get" ||
    method === "node.get" ||
    method === "node.query" ||
    method === "node.export"
  ) {
    return true;
  }
  const action =
    params && typeof params === "object" && "action" in params
      ? (params as { action?: unknown }).action
      : undefined;
  return [
    "inspect",
    "search",
    "validate",
    "read",
    "library_search",
    "library_inspect",
    "slots",
  ].includes(String(action));
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function targetNodeIds(params: unknown): string[] {
  const ids = new Set<string>();
  const pluralKeys = new Set(["nodeIds", "instanceIds"]);
  const singularKeys = new Set([
    "nodeId",
    "instanceId",
    "parentId",
    "componentId",
    "componentSetId",
  ]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (pluralKeys.has(key) && Array.isArray(item)) {
        for (const id of item) if (typeof id === "string") ids.add(id);
      } else if (singularKeys.has(key) && typeof item === "string") {
        ids.add(item);
      }
      visit(item);
    }
  };
  visit(params);
  return [...ids].sort();
}

function writeMetadata(params: unknown): WriteMetadata {
  const input =
    params && typeof params === "object"
      ? (params as Record<string, unknown>)
      : {};
  const expectedRevision = input.expectedRevision;
  const idempotencyKey = input.idempotencyKey;
  if (expectedRevision !== undefined && typeof expectedRevision !== "string") {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "expectedRevision must be a string.",
    );
  }
  if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "idempotencyKey must be a string.",
    );
  }
  return {
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    targetNodeIds: targetNodeIds(params),
  };
}

export class PluginWriteCoordinator {
  readonly #sessions: PluginSessionRegistry;
  readonly #requestTimeoutMs: number;
  readonly #maxWriteQueue: number;
  readonly #sendJson: PluginWriteCoordinatorOptions["sendJson"];
  readonly #eventLog: EventSink | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #metrics: PluginMetric[] = [];
  readonly #writeTails = new Map<string, Promise<void>>();
  readonly #writeQueueDepth = new Map<string, number>();
  readonly #idempotency = new Map<string, IdempotencyEntry>();

  constructor(options: PluginWriteCoordinatorOptions) {
    this.#sessions = options.sessions;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#maxWriteQueue = options.maxWriteQueue;
    this.#sendJson = options.sendJson;
    this.#eventLog = options.eventLog;
  }

  metrics(): PluginMetric[] {
    return this.#metrics.map((metric) => ({ ...metric }));
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      const unknownWriteOutcome = pending.dispatched && !pending.readOnly;
      if (unknownWriteOutcome) {
        this.#eventLog?.emit({
          level: "error",
          traceId: pending.command.traceId,
          requestId: pending.command.requestId,
          clientId: pending.command.clientId,
          sessionId: pending.command.sessionId,
          fileKey: pending.command.fileKey,
          method: pending.command.method,
          action: "unknown_outcome",
          errorCode: "UNKNOWN_OUTCOME",
          retryable: false,
        });
      }
      pending.reject(
        new McpFigError(
          unknownWriteOutcome ? "UNKNOWN_OUTCOME" : "NOT_CONNECTED",
          unknownWriteOutcome
            ? "Desktop Plugin bridge closed after a write was dispatched; its outcome is unknown."
            : "Desktop Plugin bridge closed.",
          {
            retryable: !unknownWriteOutcome,
            details: {
              requestId: pending.command.requestId,
              sessionId: pending.command.sessionId,
              fileKey: pending.command.fileKey,
              dispatched: pending.dispatched,
            },
          },
        ),
      );
    }
    this.#pending.clear();
    this.#writeTails.clear();
    this.#writeQueueDepth.clear();
    this.#idempotency.clear();
  }

  markDispatched(command: PluginCommand): void {
    const pending = this.#pending.get(command.requestId);
    if (pending) pending.dispatched = true;
    this.#eventLog?.emit({
      level: "info",
      traceId: command.traceId,
      requestId: command.requestId,
      clientId: command.clientId,
      sessionId: command.sessionId,
      fileKey: command.fileKey,
      method: command.method,
      action: "dispatch",
      ...(command.targetNodeIds
        ? { targetNodeIds: command.targetNodeIds }
        : {}),
    });
  }

  acceptResult(
    routeSessionId: string,
    result: PluginResult,
    responseCompletedAt: string,
  ): boolean {
    const session = this.#sessions.get(routeSessionId);
    const pending = this.#pending.get(result.requestId);
    if (
      !session ||
      !pending ||
      pending.command.clientId !== result.clientId ||
      pending.command.sessionId !== result.sessionId ||
      pending.command.fileKey !== result.fileKey ||
      result.sessionId !== routeSessionId
    ) {
      return false;
    }
    this.#pending.delete(result.requestId);
    clearTimeout(pending.timeout);
    if (result.revision)
      this.#sessions.updateRevision(session, result.revision);
    this.#recordMetric(pending.command, result, responseCompletedAt);
    this.#eventLog?.emit({
      level: result.ok ? "info" : "error",
      traceId: pending.command.traceId,
      requestId: result.requestId,
      clientId: result.clientId,
      sessionId: result.sessionId,
      fileKey: result.fileKey,
      method: pending.command.method,
      action: "figma.api.result",
      ...(pending.command.targetNodeIds
        ? { targetNodeIds: pending.command.targetNodeIds }
        : {}),
      ...(result.revision ? { revision: result.revision } : {}),
      ...(!result.ok && result.error
        ? {
            errorCode: result.error.code,
            retryable: result.error.retryable ?? false,
          }
        : {}),
      latencyMs: duration(
        result.figmaApiStartedAt ?? result.receivedAt,
        result.figmaApiCompletedAt ?? result.completedAt,
      ),
    });
    if (result.ok) {
      pending.resolve(result.data);
    } else {
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
    return true;
  }

  async request(
    clientId: string,
    method: string,
    params: unknown,
    options: PluginRequestOptions = {},
  ): Promise<unknown> {
    const session = options.fileKey
      ? this.#sessions.forFile(options.fileKey)
      : this.#sessions.latest();
    if (!session) {
      const hasOtherFile = options.fileKey && this.#sessions.latest();
      throw new McpFigError(
        hasOtherFile ? "FILE_NOT_TARGETED" : "NOT_CONNECTED",
        hasOtherFile
          ? `No paired Desktop Plugin session targets file ${options.fileKey}.`
          : "No active Figma Desktop Plugin session is paired.",
        {
          retryable: true,
          details: {
            ...(options.fileKey ? { fileKey: options.fileKey } : {}),
            dispatched: false,
          },
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
    const readOnly = isReadOnlyRequest(method, params);
    if (readOnly) {
      return this.#dispatchRequest(
        session,
        clientId,
        method,
        params,
        true,
        {},
        options,
      );
    }

    const metadata = writeMetadata(params);
    const fingerprint = canonicalJson({ method, params });
    const idempotencyMapKey = metadata.idempotencyKey
      ? `${session.handshake.file.key}\u0000${metadata.idempotencyKey}`
      : undefined;
    if (idempotencyMapKey) {
      const existing = this.#idempotency.get(idempotencyMapKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            "An idempotency key cannot be reused with a different write payload.",
            { details: { idempotencyKey: metadata.idempotencyKey } },
          );
        }
        return existing.promise;
      }
    }

    const fileKey = session.handshake.file.key;
    const deadline = Date.now() + (options.timeoutMs ?? this.#requestTimeoutMs);
    const operation = this.#enqueueWrite(fileKey, async () => {
      const remainingTimeoutMs = deadline - Date.now();
      if (remainingTimeoutMs <= 0) {
        throw new McpFigError(
          "BUSY",
          `Write expired while waiting in the queue for file ${fileKey}.`,
          { retryable: true, details: { fileKey } },
        );
      }
      const activeSession = this.#sessions.forFile(fileKey);
      if (!activeSession) {
        throw new McpFigError(
          "NOT_CONNECTED",
          `No active Desktop Plugin session targets file ${fileKey}.`,
          { retryable: true, details: { fileKey } },
        );
      }
      if (
        metadata.expectedRevision &&
        metadata.expectedRevision !== activeSession.handshake.file.revision
      ) {
        throw new McpFigError(
          "REVISION_CONFLICT",
          `Expected revision ${metadata.expectedRevision}, but file ${fileKey} is at ${activeSession.handshake.file.revision}.`,
          {
            retryable: true,
            details: {
              fileKey,
              expectedRevision: metadata.expectedRevision,
              actualRevision: activeSession.handshake.file.revision,
              targetNodeIds: metadata.targetNodeIds,
            },
          },
        );
      }
      return this.#dispatchRequest(
        activeSession,
        clientId,
        method,
        params,
        false,
        metadata,
        { ...options, timeoutMs: remainingTimeoutMs },
      );
    });
    if (idempotencyMapKey) {
      const entry: IdempotencyEntry = {
        fingerprint,
        promise: operation,
        settled: false,
      };
      this.#idempotency.set(idempotencyMapKey, entry);
      void operation.then(
        () => {
          entry.settled = true;
        },
        (error: unknown) => {
          entry.settled = true;
          if (
            error instanceof McpFigError &&
            ["BUSY", "NOT_CONNECTED"].includes(error.code) &&
            this.#idempotency.get(idempotencyMapKey) === entry
          ) {
            this.#idempotency.delete(idempotencyMapKey);
          }
        },
      );
      if (this.#idempotency.size > 1_000) {
        const settled = [...this.#idempotency.entries()].find(
          ([, candidate]) => candidate.settled,
        );
        if (settled) this.#idempotency.delete(settled[0]);
      }
    }
    return operation;
  }

  #enqueueWrite(
    fileKey: string,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const depth = this.#writeQueueDepth.get(fileKey) ?? 0;
    if (depth >= this.#maxWriteQueue) {
      return Promise.reject(
        new McpFigError("BUSY", `Write queue for file ${fileKey} is full.`, {
          retryable: true,
          details: { fileKey, queueDepth: depth },
        }),
      );
    }
    this.#writeQueueDepth.set(fileKey, depth + 1);
    const previous = this.#writeTails.get(fileKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#writeTails.set(fileKey, tail);
    void tail.finally(() => {
      const remaining = Math.max(
        0,
        (this.#writeQueueDepth.get(fileKey) ?? 1) - 1,
      );
      if (remaining === 0) this.#writeQueueDepth.delete(fileKey);
      else this.#writeQueueDepth.set(fileKey, remaining);
      if (this.#writeTails.get(fileKey) === tail) {
        this.#writeTails.delete(fileKey);
      }
    });
    return operation;
  }

  #dispatchRequest(
    session: PluginSessionState,
    clientId: string,
    method: string,
    params: unknown,
    readOnly: boolean,
    metadata: Partial<WriteMetadata>,
    options: PluginRequestOptions,
  ): Promise<unknown> {
    const now = new Date().toISOString();
    const command: PluginCommand = {
      protocol: PLUGIN_PROTOCOL_V1,
      traceId: options.traceId ?? randomUUID(),
      requestId: randomUUID(),
      clientId,
      sessionId: session.handshake.sessionId,
      fileKey: session.handshake.file.key,
      method,
      params,
      ...(metadata.expectedRevision
        ? { expectedRevision: metadata.expectedRevision }
        : {}),
      ...(metadata.idempotencyKey
        ? { idempotencyKey: metadata.idempotencyKey }
        : {}),
      ...(metadata.targetNodeIds?.length
        ? { targetNodeIds: metadata.targetNodeIds }
        : {}),
      createdAt: now,
      dispatchedAt: now,
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(command.requestId);
        this.#pending.delete(command.requestId);
        const queuedIndex = session.queue.findIndex(
          (queued) => queued.requestId === command.requestId,
        );
        if (queuedIndex >= 0) session.queue.splice(queuedIndex, 1);
        const unknownWriteOutcome = pending?.dispatched && !pending.readOnly;
        if (unknownWriteOutcome && pending) {
          this.#eventLog?.emit({
            level: "error",
            traceId: pending.command.traceId,
            requestId: pending.command.requestId,
            clientId: pending.command.clientId,
            sessionId: pending.command.sessionId,
            fileKey: pending.command.fileKey,
            method: pending.command.method,
            action: "unknown_outcome",
            errorCode: "UNKNOWN_OUTCOME",
            retryable: false,
          });
        }
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
      }, options.timeoutMs ?? this.#requestTimeoutMs);
      this.#pending.set(command.requestId, {
        command,
        resolve,
        reject,
        timeout,
        dispatched: false,
        readOnly,
      });
      let waiter: ServerResponse | undefined;
      for (;;) {
        const candidate = session.waiters.shift();
        if (!candidate) break;
        if (
          !candidate.writableEnded &&
          !candidate.destroyed &&
          !candidate.req.aborted
        ) {
          waiter = candidate;
          break;
        }
      }
      if (waiter) {
        this.#eventLog?.emit({
          level: "debug",
          traceId: command.traceId,
          requestId: command.requestId,
          clientId: command.clientId,
          sessionId: command.sessionId,
          fileKey: command.fileKey,
          method: command.method,
          action: "waiter.close",
        });
        this.markDispatched(command);
        this.#sendJson(waiter, 200, command);
      } else {
        session.queue.push(command);
      }
    });
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
      traceId: command.traceId,
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
    if (this.#metrics.length > 1_000) {
      this.#metrics.splice(0, this.#metrics.length - 1_000);
    }
  }
}
