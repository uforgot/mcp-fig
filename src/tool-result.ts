import { toMcpFigError } from "./errors.js";
import {
  createTraceId,
  currentTraceId,
  runWithTrace,
} from "./observability/trace-context.js";

interface SuccessEnvelope {
  ok: true;
  tool: string;
  action: string;
  data: Record<string, unknown>;
  changes: Record<string, unknown>[];
  warnings: string[];
  traceId: string;
}

function textResult(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError,
  };
}

export function success(
  tool: string,
  action: string,
  data: Record<string, unknown>,
  options: {
    changes?: Record<string, unknown>[];
    warnings?: string[];
  } = {},
) {
  const payload: SuccessEnvelope = {
    ok: true,
    tool,
    action,
    data,
    changes: options.changes ?? [],
    warnings: options.warnings ?? [],
    traceId: currentTraceId() ?? createTraceId(),
  };
  return textResult(payload as unknown as Record<string, unknown>);
}

export function failure(tool: string, action: string, error: unknown) {
  const normalized = toMcpFigError(error);
  return textResult(
    {
      ok: false,
      tool,
      action,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
      traceId: currentTraceId() ?? createTraceId(),
    },
    true,
  );
}

export async function handleToolCall(
  tool: string,
  action: string,
  operation: () => Promise<ReturnType<typeof success>>,
) {
  return runWithTrace(createTraceId(), async () => {
    try {
      return await operation();
    } catch (error) {
      return failure(tool, action, error);
    }
  });
}
