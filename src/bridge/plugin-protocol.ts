import { McpFigError } from "../errors.js";

export const PLUGIN_PROTOCOL_V1 = "mcp-fig-plugin/v1" as const;

export const PLUGIN_CAPABILITIES = [
  "document.read",
  "selection.read",
  "node.read",
  "node.write",
  "layout.write",
  "component.write",
  "instance.write",
  "tokens.write",
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export interface PluginFileIdentity {
  key: string;
  name: string;
  revision: string;
}

export interface PluginHandshake {
  protocol: typeof PLUGIN_PROTOCOL_V1;
  traceId?: string;
  sessionId: string;
  clientId: string;
  file: PluginFileIdentity;
  capabilities: PluginCapability[];
  sentAt: string;
}

export interface PluginCommand {
  protocol: typeof PLUGIN_PROTOCOL_V1;
  traceId: string;
  requestId: string;
  clientId: string;
  sessionId: string;
  fileKey: string;
  method: string;
  params: unknown;
  expectedRevision?: string;
  idempotencyKey?: string;
  targetNodeIds?: string[];
  createdAt: string;
  dispatchedAt: string;
}

export interface PluginResult {
  protocol: typeof PLUGIN_PROTOCOL_V1;
  traceId?: string;
  requestId: string;
  clientId: string;
  sessionId: string;
  fileKey: string;
  ok: boolean;
  revision?: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  receivedAt: string;
  completedAt: string;
  pluginReceivedAt?: string;
  figmaApiStartedAt?: string;
  figmaApiCompletedAt?: string;
  sceneTraversalNodeCount?: number;
}

export interface PluginMetric {
  traceId: string;
  requestId: string;
  clientId: string;
  sessionId: string;
  fileKey: string;
  method: string;
  createdAt: string;
  dispatchedAt: string;
  receivedAt: string;
  completedAt: string;
  serverReceivedAt: string;
  bridgeSentAt: string;
  pluginReceivedAt: string;
  figmaApiStartedAt: string;
  figmaApiCompletedAt: string;
  responseCompletedAt: string;
  queueMs: number;
  requestTransportMs: number;
  figmaApiMs: number;
  responseTransportMs: number;
  pluginMs: number;
  totalMs: number;
  requestBytes: number;
  responseBytes: number;
  sceneTraversalNodeCount: number;
  ok: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Protocol payload must be an object.",
    );
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Protocol field ${key} must be a non-empty string.`,
    );
  }
  return field;
}

function assertProtocol(value: Record<string, unknown>): void {
  if (value.protocol !== PLUGIN_PROTOCOL_V1) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Unsupported Desktop Plugin protocol version.",
    );
  }
}

export function parseHandshake(value: unknown): PluginHandshake {
  const input = record(value);
  assertProtocol(input);
  const rawFile = record(input.file);
  const rawCapabilities = input.capabilities;
  if (!Array.isArray(rawCapabilities)) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Protocol capabilities must be an array.",
    );
  }
  const capabilities = rawCapabilities.map((capability) => {
    if (!PLUGIN_CAPABILITIES.includes(capability as PluginCapability)) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Unknown plugin capability: ${String(capability)}`,
      );
    }
    return capability as PluginCapability;
  });
  return {
    protocol: PLUGIN_PROTOCOL_V1,
    traceId:
      typeof input.traceId === "string" && input.traceId.length > 0
        ? input.traceId
        : stringField(input, "sessionId"),
    sessionId: stringField(input, "sessionId"),
    clientId: stringField(input, "clientId"),
    file: {
      key: stringField(rawFile, "key"),
      name: stringField(rawFile, "name"),
      revision: stringField(rawFile, "revision"),
    },
    capabilities,
    sentAt: stringField(input, "sentAt"),
  };
}

export function parseResult(value: unknown): PluginResult {
  const input = record(value);
  assertProtocol(input);
  if (typeof input.ok !== "boolean") {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Protocol result ok must be boolean.",
    );
  }
  const base = {
    protocol: PLUGIN_PROTOCOL_V1,
    traceId:
      typeof input.traceId === "string" && input.traceId.length > 0
        ? input.traceId
        : stringField(input, "requestId"),
    requestId: stringField(input, "requestId"),
    clientId: stringField(input, "clientId"),
    sessionId: stringField(input, "sessionId"),
    fileKey: stringField(input, "fileKey"),
    ok: input.ok,
    ...(typeof input.revision === "string" && input.revision.length > 0
      ? { revision: input.revision }
      : {}),
    receivedAt: stringField(input, "receivedAt"),
    completedAt: stringField(input, "completedAt"),
    ...(typeof input.pluginReceivedAt === "string"
      ? { pluginReceivedAt: input.pluginReceivedAt }
      : {}),
    ...(typeof input.figmaApiStartedAt === "string"
      ? { figmaApiStartedAt: input.figmaApiStartedAt }
      : {}),
    ...(typeof input.figmaApiCompletedAt === "string"
      ? { figmaApiCompletedAt: input.figmaApiCompletedAt }
      : {}),
    ...(typeof input.sceneTraversalNodeCount === "number"
      ? { sceneTraversalNodeCount: input.sceneTraversalNodeCount }
      : {}),
  };
  if (input.ok) return { ...base, data: input.data };
  const rawError = record(input.error);
  return {
    ...base,
    error: {
      code: stringField(rawError, "code"),
      message: stringField(rawError, "message"),
      ...(typeof rawError.retryable === "boolean"
        ? { retryable: rawError.retryable }
        : {}),
      ...(rawError.details && typeof rawError.details === "object"
        ? { details: rawError.details as Record<string, unknown> }
        : {}),
    },
  };
}
