import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage<string>();

export function createTraceId(): string {
  return randomUUID();
}

export function currentTraceId(): string | undefined {
  return storage.getStore();
}

export function runWithTrace<Value>(
  traceId: string,
  operation: () => Value,
): Value {
  return storage.run(traceId, operation);
}

export function traceIdOrCreate(): string {
  return currentTraceId() ?? createTraceId();
}
