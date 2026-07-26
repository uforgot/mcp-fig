import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface EventInput {
  level: EventLevel;
  traceId: string;
  requestId?: string;
  clientId?: string;
  sessionId?: string;
  fileKey?: string;
  method?: string;
  action: string;
  targetNodeIds?: string[];
  revision?: string;
  errorCode?: string;
  latencyMs?: number;
  retryable?: boolean;
}

export interface EventRecord extends EventInput {
  timestamp: string;
  daemonPid: number;
}

export interface EventSink {
  emit(event: EventInput): void;
}

interface WritableLike {
  write(chunk: string | Uint8Array): unknown;
}

export interface EventLoggerOptions {
  stderr?: WritableLike;
  jsonlPath?: string;
  maxBytes?: number;
  backups?: number;
  daemonPid?: number;
  now?: () => Date;
}

const LEVELS = new Set<EventLevel>(["debug", "info", "warn", "error"]);

function cleanString(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cleaned = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  return cleaned.slice(0, max);
}

function normalizeTargetNodeIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .slice(0, 100)
    .map((item) => cleanString(item, 256))
    .filter((item): item is string => Boolean(item));
  return ids.length ? ids : undefined;
}

function normalizeEvent(
  value: unknown,
  timestamp: string,
  daemonPid: number,
): EventRecord {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const level = LEVELS.has(input.level as EventLevel)
    ? (input.level as EventLevel)
    : undefined;
  const traceId = cleanString(input.traceId, 256);
  const action = cleanString(input.action, 256);
  if (!level || !traceId || !action) {
    return {
      timestamp,
      level: "warn",
      traceId: "invalid-event",
      daemonPid,
      action: "event.invalid",
      errorCode: "INVALID_EVENT",
      retryable: false,
    };
  }
  const latencyMs =
    typeof input.latencyMs === "number" &&
    Number.isFinite(input.latencyMs) &&
    input.latencyMs >= 0
      ? input.latencyMs
      : undefined;
  const targetNodeIds = normalizeTargetNodeIds(input.targetNodeIds);
  const record: EventRecord = {
    timestamp,
    level,
    traceId,
    daemonPid,
    action,
  };
  for (const key of [
    "requestId",
    "clientId",
    "sessionId",
    "fileKey",
    "method",
    "revision",
    "errorCode",
  ] as const) {
    const cleaned = cleanString(input[key]);
    if (cleaned) record[key] = cleaned;
  }
  if (targetNodeIds) record.targetNodeIds = targetNodeIds;
  if (latencyMs !== undefined) record.latencyMs = latencyMs;
  if (typeof input.retryable === "boolean") record.retryable = input.retryable;
  return record;
}

async function verifyFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Event log path is not a regular file: ${path}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`Event log is not owned by the current user: ${path}`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`Event log must not be group/other accessible: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function rotate(
  path: string,
  maxBytes: number,
  backups: number,
  incoming: number,
) {
  await verifyFile(path);
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size === 0 || size + incoming <= maxBytes) return;
  if (backups > 0) {
    await rm(`${path}.${backups}`, { force: true });
    for (let index = backups - 1; index >= 1; index -= 1) {
      try {
        await rename(`${path}.${index}`, `${path}.${index + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rename(path, `${path}.1`);
    await chmod(`${path}.1`, 0o600);
  } else {
    await rm(path, { force: true });
  }
}

export class EventLogger implements EventSink {
  readonly #stderr: WritableLike;
  readonly #jsonlPath: string | undefined;
  readonly #maxBytes: number;
  readonly #backups: number;
  readonly #daemonPid: number;
  readonly #now: () => Date;
  #pending = Promise.resolve();

  constructor(options: EventLoggerOptions = {}) {
    this.#stderr = options.stderr ?? process.stderr;
    this.#jsonlPath = options.jsonlPath;
    this.#maxBytes = options.maxBytes ?? 1_000_000;
    this.#backups = options.backups ?? 3;
    this.#daemonPid = options.daemonPid ?? process.pid;
    this.#now = options.now ?? (() => new Date());
  }

  emit(event: EventInput): void {
    const record = normalizeEvent(
      event,
      this.#now().toISOString(),
      this.#daemonPid,
    );
    const line = `${JSON.stringify(record)}\n`;
    this.#stderr.write(line);
    if (!this.#jsonlPath) return;
    this.#pending = this.#pending
      .then(async () => {
        const path = this.#jsonlPath as string;
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await rotate(
          path,
          this.#maxBytes,
          this.#backups,
          Buffer.byteLength(line),
        );
        await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
        await chmod(path, 0o600);
      })
      .catch(() => {
        const failure = normalizeEvent(
          {
            level: "error",
            traceId: record.traceId,
            action: "event.write_failed",
            errorCode: "EVENT_LOG_WRITE_FAILED",
            retryable: false,
          },
          this.#now().toISOString(),
          this.#daemonPid,
        );
        this.#stderr.write(`${JSON.stringify(failure)}\n`);
      });
  }

  flush(): Promise<void> {
    return this.#pending;
  }
}
