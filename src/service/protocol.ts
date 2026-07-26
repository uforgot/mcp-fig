import type { PluginHandshake } from "../bridge/plugin-protocol.js";
import type { BridgeStatus } from "../bridge/types.js";
import type { ErrorCode } from "../errors.js";

export const SERVICE_PROTOCOL_V1 = "mcp-fig-service/v1" as const;

export const SERVICE_METHODS = [
  "health",
  "status",
  "sessions",
  "request",
] as const;

export type ServiceMethod = (typeof SERVICE_METHODS)[number];
export type ServiceErrorCode =
  | ErrorCode
  | "INVALID_REQUEST"
  | "PROTOCOL_MISMATCH"
  | "SERVICE_UNAVAILABLE"
  | "SERVICE_BUSY"
  | "INTERNAL_ERROR";

export interface ServiceSessionIdentity {
  sessionId: string;
  clientId: string;
  file: {
    key: string;
    name: string;
    revision: string;
  };
}

export interface ServiceHealth {
  protocol: typeof SERVICE_PROTOCOL_V1;
  pid: number;
  version: string;
  startedAt: string;
  uptimeMs: number;
  plugin: {
    host: "127.0.0.1";
    port: number;
  };
  sessions: ServiceSessionIdentity[];
}

export interface ServiceStatus {
  daemon: ServiceHealth;
  bridge: BridgeStatus;
}

export interface ServiceRequestParams {
  health: Record<string, never>;
  status: { fileKey?: string };
  sessions: Record<string, never>;
  request: {
    clientId: string;
    method: string;
    params: unknown;
    options?: { fileKey?: string; timeoutMs?: number };
  };
}

export type ServiceRequest = {
  [Method in ServiceMethod]: {
    protocol: typeof SERVICE_PROTOCOL_V1;
    traceId: string;
    requestId: string;
    method: Method;
    params: ServiceRequestParams[Method];
  };
}[ServiceMethod];

export type ServiceSuccessData =
  | ServiceHealth
  | ServiceStatus
  | BridgeStatus
  | PluginHandshake[]
  | unknown;

export interface ServiceSuccessResponse {
  protocol: typeof SERVICE_PROTOCOL_V1;
  traceId: string;
  requestId: string;
  ok: true;
  data: ServiceSuccessData;
}

export interface ServiceErrorResponse {
  protocol: typeof SERVICE_PROTOCOL_V1;
  traceId: string;
  requestId: string;
  ok: false;
  error: {
    code: ServiceErrorCode;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

export type ServiceResponse = ServiceSuccessResponse | ServiceErrorResponse;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function protocolError(message: string): ServiceProtocolError {
  return new ServiceProtocolError("INVALID_REQUEST", message);
}

export class ServiceProtocolError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceProtocolError";
    this.code = code;
  }
}

export function parseServiceRequest(value: unknown): ServiceRequest {
  const input = objectValue(value);
  if (!input) throw protocolError("Service request must be an object.");
  if (input.protocol !== SERVICE_PROTOCOL_V1) {
    throw new ServiceProtocolError(
      "PROTOCOL_MISMATCH",
      `Expected service protocol ${SERVICE_PROTOCOL_V1}.`,
    );
  }
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw protocolError("Service requestId must be a non-empty string.");
  }
  if (
    typeof input.method !== "string" ||
    !SERVICE_METHODS.includes(input.method as ServiceMethod)
  ) {
    throw protocolError("Unknown service method.");
  }
  const params = objectValue(input.params);
  if (!params) throw protocolError("Service params must be an object.");

  if (input.method === "status") {
    if (params.fileKey !== undefined && typeof params.fileKey !== "string") {
      throw protocolError("Service status fileKey must be a string.");
    }
  }
  if (input.method === "request") {
    if (
      typeof params.clientId !== "string" ||
      typeof params.method !== "string"
    ) {
      throw protocolError(
        "Service request requires clientId and method strings.",
      );
    }
    const options =
      params.options === undefined ? undefined : objectValue(params.options);
    if (params.options !== undefined && !options) {
      throw protocolError("Service request options must be an object.");
    }
    if (
      options &&
      ((options.fileKey !== undefined && typeof options.fileKey !== "string") ||
        (options.timeoutMs !== undefined &&
          typeof options.timeoutMs !== "number"))
    ) {
      throw protocolError("Service request options are invalid.");
    }
  }
  return {
    ...input,
    traceId:
      typeof input.traceId === "string" && input.traceId.length > 0
        ? input.traceId
        : String(input.requestId),
  } as ServiceRequest;
}

export function parseServiceResponse(
  value: unknown,
  expectedRequestId: string,
  expectedTraceId?: string,
): ServiceResponse {
  const input = objectValue(value);
  if (!input) {
    throw new ServiceProtocolError(
      "INVALID_REQUEST",
      "Service response must be an object.",
    );
  }
  if (input.protocol !== SERVICE_PROTOCOL_V1) {
    throw new ServiceProtocolError(
      "PROTOCOL_MISMATCH",
      `Expected service protocol ${SERVICE_PROTOCOL_V1}.`,
    );
  }
  if (input.requestId !== expectedRequestId) {
    throw new ServiceProtocolError(
      "INVALID_REQUEST",
      "Service response requestId does not match.",
    );
  }
  const traceId =
    typeof input.traceId === "string" && input.traceId.length > 0
      ? input.traceId
      : expectedRequestId;
  if (expectedTraceId && traceId !== expectedTraceId) {
    throw new ServiceProtocolError(
      "INVALID_REQUEST",
      "Service response traceId does not match.",
    );
  }
  if (input.ok === true) {
    return { ...input, traceId } as unknown as ServiceSuccessResponse;
  }
  const error = objectValue(input.error);
  if (
    input.ok !== false ||
    !error ||
    typeof error.code !== "string" ||
    typeof error.message !== "string"
  ) {
    throw new ServiceProtocolError(
      "INVALID_REQUEST",
      "Service error response is invalid.",
    );
  }
  return { ...input, traceId } as unknown as ServiceErrorResponse;
}

export function serviceSessionIdentity(
  handshake: PluginHandshake,
): ServiceSessionIdentity {
  return {
    sessionId: handshake.sessionId,
    clientId: handshake.clientId,
    file: {
      key: handshake.file.key,
      name: handshake.file.name,
      revision: handshake.file.revision,
    },
  };
}
