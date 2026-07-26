import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ServiceSocketErrorCode =
  | "SERVICE_UNAVAILABLE"
  | "SOCKET_IN_USE"
  | "SOCKET_NOT_OWNER_ONLY"
  | "STALE_SOCKET_INVALID";

export class ServiceSocketError extends Error {
  readonly code: ServiceSocketErrorCode;

  constructor(code: ServiceSocketErrorCode, message: string) {
    super(message);
    this.name = "ServiceSocketError";
    this.code = code;
  }
}

export interface ServiceSocketIdentity {
  dev: number;
  ino: number;
  uid: number;
}

export function defaultServiceSocketPath(home = homedir()): string {
  return join(
    home,
    "Library",
    "Application Support",
    "mcp-fig",
    "service.sock",
  );
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function assertOwner(path: string, mode: number): Promise<void> {
  const info = await lstat(path);
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new ServiceSocketError(
      "SOCKET_NOT_OWNER_ONLY",
      `Service socket is owned by uid ${info.uid}, expected ${uid}.`,
    );
  }
  if ((info.mode & 0o077) !== 0 || (info.mode & 0o700) !== mode) {
    throw new ServiceSocketError(
      "SOCKET_NOT_OWNER_ONLY",
      "Service socket permissions must be 0600.",
    );
  }
}

async function socketIsListening(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out probing service socket."));
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (["ECONNREFUSED", "ENOENT"].includes(error.code ?? "")) {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

export async function prepareServiceSocket(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  const uid = currentUid();
  if (uid !== undefined && directoryInfo.uid !== uid) {
    throw new ServiceSocketError(
      "SOCKET_NOT_OWNER_ONLY",
      `Service directory is owned by uid ${directoryInfo.uid}, expected ${uid}.`,
    );
  }
  if ((directoryInfo.mode & 0o077) !== 0) {
    throw new ServiceSocketError(
      "SOCKET_NOT_OWNER_ONLY",
      "Service directory permissions must not allow group or other access.",
    );
  }

  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket()) {
    throw new ServiceSocketError(
      "STALE_SOCKET_INVALID",
      "Refusing to replace a non-socket service path.",
    );
  }
  const owner = currentUid();
  if (owner !== undefined && info.uid !== owner) {
    throw new ServiceSocketError(
      "SOCKET_NOT_OWNER_ONLY",
      "Refusing to replace a service socket owned by another user.",
    );
  }
  if (await socketIsListening(path)) {
    throw new ServiceSocketError(
      "SOCKET_IN_USE",
      "Another MCP Fig service is already listening.",
    );
  }
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !current.isSocket() ||
    current.dev !== info.dev ||
    current.ino !== info.ino ||
    current.uid !== info.uid
  ) {
    throw new ServiceSocketError(
      "SOCKET_IN_USE",
      "Service socket changed while stale recovery was in progress.",
    );
  }
  await unlink(path);
}

export async function secureServiceSocket(
  path: string,
): Promise<ServiceSocketIdentity> {
  await chmod(path, 0o600);
  const info = await lstat(path);
  if (!info.isSocket()) {
    throw new ServiceSocketError(
      "STALE_SOCKET_INVALID",
      "Service path is not a Unix socket.",
    );
  }
  await assertOwner(path, 0o600);
  return { dev: info.dev, ino: info.ino, uid: info.uid };
}

export async function verifyServiceSocket(path: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ServiceSocketError(
        "SERVICE_UNAVAILABLE",
        "MCP Fig service socket does not exist.",
      );
    }
    throw error;
  }
  if (!info.isSocket()) {
    throw new ServiceSocketError(
      "SERVICE_UNAVAILABLE",
      "MCP Fig service path is not a Unix socket.",
    );
  }
  await assertOwner(path, 0o600);
}

export async function removeServiceSocket(
  path: string,
  expected: ServiceSocketIdentity,
): Promise<void> {
  try {
    const info = await lstat(path);
    const uid = currentUid();
    if (
      info.isSocket() &&
      (uid === undefined || info.uid === uid) &&
      info.dev === expected.dev &&
      info.ino === expected.ino &&
      info.uid === expected.uid
    ) {
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
