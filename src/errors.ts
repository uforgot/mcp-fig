export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_CONNECTED"
  | "UNKNOWN_OUTCOME"
  | "FILE_NOT_TARGETED"
  | "FILE_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "BUSY"
  | "CONFIRMATION_REQUIRED"
  | "UNSUPPORTED_BY_BRIDGE"
  | "LIBRARY_SEARCH_UNAVAILABLE"
  | "LIBRARY_IMPORT_FAILED"
  | "SLOT_NOT_FOUND"
  | "INTERNAL_ERROR";

export class McpFigError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "McpFigError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details) {
      this.details = options.details;
    }
  }
}

export function toMcpFigError(error: unknown): McpFigError {
  if (error instanceof McpFigError) {
    return error;
  }
  return new McpFigError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unexpected MCP Fig error.",
  );
}
