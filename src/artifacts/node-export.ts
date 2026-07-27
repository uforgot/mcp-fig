import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { NodeExportFormat, NodeExportPayload } from "../bridge/types.js";
import { McpFigError } from "../errors.js";

const EXTENSIONS: Record<NodeExportFormat, string> = {
  PNG: "png",
  JPG: "jpg",
  SVG: "svg",
  PDF: "pdf",
};
const MIME_TYPES: Record<NodeExportFormat, string> = {
  PNG: "image/png",
  JPG: "image/jpeg",
  SVG: "image/svg+xml",
  PDF: "application/pdf",
};
export const DEFAULT_EXPORT_DIRECTORY_MAX_BYTES = 100_000_000;

export interface SavedNodeExport {
  nodeId: string;
  nodeName: string;
  format: NodeExportFormat;
  mimeType: string;
  byteLength: number;
  path: string;
}

export interface SaveNodeExportsOptions {
  directory?: string;
  now?: Date;
  maxDirectoryBytes?: number;
  randomId?: () => string;
}

export function defaultNodeExportDirectory(): string {
  return join(homedir(), ".mcp-fig", "exports");
}

function safeSegment(value: string, fallback: string): string {
  const safe = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}

function assertSignature(format: NodeExportFormat, bytes: Buffer): void {
  const valid =
    (format === "PNG" &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (format === "JPG" && bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (format === "PDF" && bytes.subarray(0, 5).toString("ascii") === "%PDF-") ||
    (format === "SVG" &&
      /<(?:svg)(?:\s|>)/i.test(bytes.subarray(0, 512).toString("utf8")));
  if (!valid) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Exported ${format} payload has an invalid file signature.`,
    );
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `${directory} is not a directory.`,
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `${directory} is not owned by the current user.`,
    );
  }
  await chmod(directory, 0o700);
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => (await stat(join(directory, entry.name))).size),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

export async function saveNodeExports(
  payloads: NodeExportPayload[],
  options: SaveNodeExportsOptions = {},
): Promise<SavedNodeExport[]> {
  const directory = options.directory ?? defaultNodeExportDirectory();
  await ensurePrivateDirectory(directory);
  const timestamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[:.]/g, "-");
  const randomId = options.randomId ?? randomUUID;
  const prepared: {
    artifact: SavedNodeExport;
    bytes: Buffer;
  }[] = [];

  for (const payload of payloads) {
    const bytes = Buffer.from(payload.dataBase64, "base64");
    if (
      bytes.byteLength !== payload.byteLength ||
      bytes.toString("base64") !== payload.dataBase64
    ) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Exported payload length or base64 encoding is invalid for node ${payload.nodeId}.`,
      );
    }
    assertSignature(payload.format, bytes);
    if (payload.mimeType !== MIME_TYPES[payload.format]) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Exported MIME type does not match ${payload.format} for node ${payload.nodeId}.`,
      );
    }

    const nodeName = safeSegment(payload.nodeName, "node");
    const nodeId = safeSegment(payload.nodeId, "id");
    const fileName = `${nodeName}-${nodeId}-${timestamp}-${randomId().slice(0, 8)}.${EXTENSIONS[payload.format]}`;
    const path = join(directory, fileName);
    prepared.push({
      bytes,
      artifact: {
        nodeId: payload.nodeId,
        nodeName: payload.nodeName,
        format: payload.format,
        mimeType: MIME_TYPES[payload.format],
        byteLength: payload.byteLength,
        path,
      },
    });
  }

  const maxDirectoryBytes =
    options.maxDirectoryBytes ?? DEFAULT_EXPORT_DIRECTORY_MAX_BYTES;
  const requestedBytes = prepared.reduce(
    (total, entry) => total + entry.bytes.byteLength,
    0,
  );
  const existingBytes = await directoryBytes(directory);
  if (existingBytes + requestedBytes > maxDirectoryBytes) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Export directory quota would exceed ${maxDirectoryBytes} bytes; remove old artifacts before exporting again.`,
    );
  }

  const createdPaths: string[] = [];
  try {
    for (const entry of prepared) {
      const handle = await open(entry.artifact.path, "wx", 0o600);
      createdPaths.push(entry.artifact.path);
      try {
        await handle.writeFile(entry.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    await Promise.all(createdPaths.map((path) => rm(path, { force: true })));
    throw error;
  }
  return prepared.map((entry) => entry.artifact);
}
