import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rename, rm } from "node:fs/promises";
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
  figmaAccessToken?: string;
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

export type PairingCredentialErrorCode =
  | "PAIRING_INVALID"
  | "PAIRING_EXPIRED"
  | "PAIRING_USED";

export class PairingCredentialError extends Error {
  readonly code: PairingCredentialErrorCode;

  constructor(code: PairingCredentialErrorCode, message: string) {
    super(message);
    this.name = "PairingCredentialError";
    this.code = code;
  }
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
    typeof value.rotatedAt !== "string" ||
    (value.figmaAccessToken !== undefined &&
      (typeof value.figmaAccessToken !== "string" ||
        value.figmaAccessToken.length < 8))
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
  options: { now?: number; figmaAccessToken?: string } = {},
): Promise<ServiceCredential> {
  try {
    const existing = await readCredential(paths);
    if (
      options.figmaAccessToken &&
      options.figmaAccessToken !== existing.figmaAccessToken
    ) {
      return writeCredential(paths, {
        ...existing,
        figmaAccessToken: options.figmaAccessToken,
      });
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credential: ServiceCredential = {
    version: 1,
    pluginToken: token(),
    rotatedAt: new Date(options.now ?? Date.now()).toISOString(),
    ...(options.figmaAccessToken
      ? { figmaAccessToken: options.figmaAccessToken }
      : {}),
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
  const existing = await readCredential(paths);
  await Promise.all([
    rm(paths.pairingPath, { force: true }),
    rm(paths.pairingUsedPath, { force: true }),
  ]);
  return writeCredential(paths, {
    version: 1,
    pluginToken: token(),
    rotatedAt: new Date(options.now ?? Date.now()).toISOString(),
    ...(existing.figmaAccessToken
      ? { figmaAccessToken: existing.figmaAccessToken }
      : {}),
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
  await rm(paths.pairingUsedPath, { force: true });
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
  const rejectMissingOrUsed = async (): Promise<never> => {
    try {
      const used = parsePairingRecord(
        await readOwnerOnlyFile(paths.pairingUsedPath),
      );
      const now = options.now ?? Date.now();
      if (
        now < used.expiresAt &&
        secureEqual(used.codeHash, hashCode(paths, code))
      ) {
        throw new PairingCredentialError(
          "PAIRING_USED",
          "Pairing code was already used.",
        );
      }
      if (now >= used.expiresAt) {
        await rm(paths.pairingUsedPath, { force: true });
      }
    } catch (error) {
      if (error instanceof PairingCredentialError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    throw new PairingCredentialError(
      "PAIRING_INVALID",
      "No active pairing code matches this value.",
    );
  };

  let record: PairingRecord;
  try {
    record = parsePairingRecord(await readOwnerOnlyFile(paths.pairingPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return rejectMissingOrUsed();
    }
    throw error;
  }
  const now = options.now ?? Date.now();
  if (now >= record.expiresAt) {
    await rm(paths.pairingPath, { force: true });
    throw new PairingCredentialError(
      "PAIRING_EXPIRED",
      "Pairing code expired.",
    );
  }
  if (!secureEqual(record.codeHash, hashCode(paths, code))) {
    throw new PairingCredentialError(
      "PAIRING_INVALID",
      "Invalid pairing code.",
    );
  }

  try {
    await rename(paths.pairingPath, paths.pairingUsedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return rejectMissingOrUsed();
    }
    throw error;
  }
  return readCredential(paths);
}
