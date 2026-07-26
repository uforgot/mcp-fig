import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const SERVICE_LABEL = "com.uforgot.mcp-fig";

export interface ServicePathsOptions {
  home?: string;
  label?: string;
}

export interface ServicePaths {
  home: string;
  label: string;
  appSupportDirectory: string;
  configPath: string;
  credentialPath: string;
  pairingPath: string;
  pairingUsedPath: string;
  startupStatePath: string;
  socketPath: string;
  launchAgentsDirectory: string;
  launchAgentPath: string;
  logsDirectory: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface ServiceConfig {
  version: 1;
  serviceVersion: string;
  port: number;
  socketPath: string;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function modeOf(info: Stats): number {
  return info.mode & 0o777;
}

function assertOwned(info: Stats, path: string): void {
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${path} is not owned by the current user.`);
  }
}

export function servicePaths(options: ServicePathsOptions = {}): ServicePaths {
  const home = options.home ?? homedir();
  const label = options.label ?? SERVICE_LABEL;
  if (!isAbsolute(home)) throw new Error("Service home path must be absolute.");
  if (!/^[A-Za-z0-9.-]+$/.test(label)) {
    throw new Error("Service label contains unsupported characters.");
  }
  const appSupportDirectory = join(
    home,
    "Library",
    "Application Support",
    "mcp-fig",
  );
  const launchAgentsDirectory = join(home, "Library", "LaunchAgents");
  const logsDirectory = join(home, "Library", "Logs", "mcp-fig");
  return {
    home,
    label,
    appSupportDirectory,
    configPath: join(appSupportDirectory, "service.json"),
    credentialPath: join(appSupportDirectory, "credential.json"),
    pairingPath: join(appSupportDirectory, "pairing.json"),
    pairingUsedPath: join(appSupportDirectory, "pairing-used.json"),
    startupStatePath: join(appSupportDirectory, "startup-state.json"),
    socketPath: join(appSupportDirectory, "service.sock"),
    launchAgentsDirectory,
    launchAgentPath: join(launchAgentsDirectory, `${label}.plist`),
    logsDirectory,
    stdoutLogPath: join(logsDirectory, "service.stdout.log"),
    stderrLogPath: join(logsDirectory, "service.stderr.log"),
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory.`);
  assertOwned(info, path);
  await chmod(path, 0o700);
  const secured = await lstat(path);
  if (modeOf(secured) !== 0o700) {
    throw new Error(`${path} must use owner-only 0700 permissions.`);
  }
}

async function ensureOwnerOnlyFile(path: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
  await assertOwnerOnlyFile(path);
}

export async function ensureServiceDirectories(
  paths: ServicePaths,
): Promise<void> {
  await ensurePrivateDirectory(paths.appSupportDirectory);
  await ensurePrivateDirectory(paths.logsDirectory);
  await mkdir(paths.launchAgentsDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    ensureOwnerOnlyFile(paths.stdoutLogPath),
    ensureOwnerOnlyFile(paths.stderrLogPath),
  ]);
}

export async function assertOwnerOnlyFile(path: string): Promise<Stats> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
  assertOwned(info, path);
  if (modeOf(info) !== 0o600) {
    throw new Error(`${path} must use owner-only 0600 permissions.`);
  }
  return info;
}

export async function writeOwnerOnlyFile(
  path: string,
  content: string,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    await assertOwnerOnlyFile(path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function createOwnerOnlyFile(
  path: string,
  content: string,
): Promise<boolean> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await assertOwnerOnlyFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readOwnerOnlyFile(path: string): Promise<string> {
  await assertOwnerOnlyFile(path);
  return readFile(path, "utf8");
}

export async function writeServiceConfig(
  paths: ServicePaths,
  config: ServiceConfig,
): Promise<void> {
  await writeOwnerOnlyFile(
    paths.configPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

export async function readServiceConfig(
  paths: ServicePaths,
): Promise<ServiceConfig> {
  const raw = JSON.parse(await readOwnerOnlyFile(paths.configPath)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Service config must be a JSON object.");
  }
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.serviceVersion !== "string" ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    typeof value.socketPath !== "string" ||
    !isAbsolute(value.socketPath)
  ) {
    throw new Error("Service config is malformed.");
  }
  return value as unknown as ServiceConfig;
}

export async function removeServiceFiles(paths: ServicePaths): Promise<void> {
  await rm(paths.appSupportDirectory, { recursive: true, force: true });
  await rm(paths.logsDirectory, { recursive: true, force: true });
  await rm(paths.launchAgentPath, { force: true });
}

async function rotateLog(
  path: string,
  maxBytes: number,
  backups: number,
): Promise<void> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size <= maxBytes) {
    await ensureOwnerOnlyFile(path);
    return;
  }
  await rm(`${path}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await rename(path, `${path}.1`);
  await ensureOwnerOnlyFile(path);
}

export async function rotateServiceLogs(
  paths: ServicePaths,
  options: { maxBytes?: number; backups?: number } = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const backups = options.backups ?? 3;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Log maxBytes must be a positive integer.");
  }
  if (!Number.isInteger(backups) || backups < 1 || backups > 10) {
    throw new Error("Log backups must be an integer between 1 and 10.");
  }
  await Promise.all([
    rotateLog(paths.stdoutLogPath, maxBytes, backups),
    rotateLog(paths.stderrLogPath, maxBytes, backups),
  ]);
}
