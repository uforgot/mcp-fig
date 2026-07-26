import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createOwnerOnlyFile,
  ensureServiceDirectories,
  readOwnerOnlyFile,
  type ServicePaths,
  writeOwnerOnlyFile,
} from "./paths.js";

export interface ServiceCredential {
  version: 1;
  pluginToken: string;
  rotatedAt: string;
}

interface PairingRecord {
  version: 1;
  codeHash: string;
  expiresAt: number;
  issuedAt: number;
}

export interface IssuedPairingCode {
  code: string;
  expiresAt: number;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function pairingCode(): string {
  return randomBytes(9).toString("base64url").toUpperCase();
}

function hashCode(paths: ServicePaths, code: string): string {
  return createHash("sha256")
    .update(paths.label)
    .update("\0")
    .update(code)
    .digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCredential(raw: string): ServiceCredential {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Service credential must be a JSON object.");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.pluginToken !== "string" ||
    value.pluginToken.length < 32 ||
    typeof value.rotatedAt !== "string"
  ) {
    throw new Error("Service credential is malformed.");
  }
  return value as unknown as ServiceCredential;
}

function parsePairingRecord(raw: string): PairingRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Pairing record must be a JSON object.");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.codeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.codeHash) ||
    typeof value.expiresAt !== "number" ||
    typeof value.issuedAt !== "number"
  ) {
    throw new Error("Pairing record is malformed.");
  }
  return value as unknown as PairingRecord;
}

async function writeCredential(
  paths: ServicePaths,
  credential: ServiceCredential,
): Promise<ServiceCredential> {
  await ensureServiceDirectories(paths);
  await writeOwnerOnlyFile(
    paths.credentialPath,
    `${JSON.stringify(credential, null, 2)}\n`,
  );
  return credential;
}

export async function readCredential(
  paths: ServicePaths,
): Promise<ServiceCredential> {
  return parseCredential(await readOwnerOnlyFile(paths.credentialPath));
}

export async function readOrCreateCredential(
  paths: ServicePaths,
  options: { now?: number } = {},
): Promise<ServiceCredential> {
  try {
    return await readCredential(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credential: ServiceCredential = {
    version: 1,
    pluginToken: token(),
    rotatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  await ensureServiceDirectories(paths);
  const created = await createOwnerOnlyFile(
    paths.credentialPath,
    `${JSON.stringify(credential, null, 2)}\n`,
  );
  return created ? credential : readCredential(paths);
}

export async function rotateCredential(
  paths: ServicePaths,
  options: { now?: number } = {},
): Promise<ServiceCredential> {
  await rm(paths.pairingPath, { force: true });
  return writeCredential(paths, {
    version: 1,
    pluginToken: token(),
    rotatedAt: new Date(options.now ?? Date.now()).toISOString(),
  });
}

export async function issuePairingCode(
  paths: ServicePaths,
  options: { now?: number; ttlMs?: number } = {},
): Promise<IssuedPairingCode> {
  await readCredential(paths);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 120_000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 120_000) {
    throw new Error("Pairing code TTL must be between 1 and 120000ms.");
  }
  const code = pairingCode();
  const record: PairingRecord = {
    version: 1,
    codeHash: hashCode(paths, code),
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  await writeOwnerOnlyFile(
    paths.pairingPath,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return { code, expiresAt: record.expiresAt };
}

export async function consumePairingCode(
  paths: ServicePaths,
  code: string,
  options: { now?: number } = {},
): Promise<ServiceCredential> {
  let record: PairingRecord;
  try {
    record = parsePairingRecord(await readOwnerOnlyFile(paths.pairingPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "No pairing code is available; it may be expired or used.",
      );
    }
    throw error;
  }
  const now = options.now ?? Date.now();
  if (now >= record.expiresAt) {
    await rm(paths.pairingPath, { force: true });
    throw new Error("Pairing code expired.");
  }
  if (!secureEqual(record.codeHash, hashCode(paths, code))) {
    throw new Error("Invalid pairing code.");
  }

  const claimPath = join(
    paths.appSupportDirectory,
    `.pairing-claim-${process.pid}-${randomBytes(4).toString("hex")}.json`,
  );
  try {
    await rename(paths.pairingPath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Pairing code was already used.");
    }
    throw error;
  }
  try {
    return await readCredential(paths);
  } finally {
    await rm(claimPath, { force: true });
  }
}
