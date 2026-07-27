import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  ScreenshotPreparation,
  ScreenshotScope,
} from "../bridge/types.js";
import { McpFigError } from "../errors.js";

const execFile = promisify(execFileCallback);
export const SCREENSHOT_MAX_BYTES = 8_000_000;
export const SCREENSHOT_DIRECTORY_MAX_BYTES = 100_000_000;

export interface DesktopWindow {
  id: number;
  name: string;
  owner: string;
  onScreen: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ScreenshotArtifact {
  scope: ScreenshotScope;
  focusNodeIds: string[];
  mimeType: "image/png";
  byteLength: number;
  width: number;
  height: number;
  scale: number;
  path: string;
  window: DesktopWindow;
  viewportBounds: ScreenshotPreparation["viewportBounds"];
  focusBounds?: ScreenshotPreparation["focusBounds"];
}

export interface DesktopScreenshotOptions {
  maxBytes: number;
  scale: number;
  delayMs: number;
}

export interface DesktopScreenshotDependencies {
  directory?: string;
  tempRoot?: string;
  now?: Date;
  randomId?: () => string;
  findWindow?: (fileName: string) => Promise<DesktopWindow>;
  captureWindow?: (windowId: number, path: string) => Promise<void>;
  resizePng?: (path: string, width: number, height: number) => Promise<void>;
  maxDirectoryBytes?: number;
}

const WINDOW_SCRIPT = `
ObjC.import("CoreGraphics");
const list = $.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionAll,
  $.kCGNullWindowID,
);
const out = [];
for (let i = 0, n = $.CFArrayGetCount(list); i < n; i++) {
  const dict = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
  const get = (key) => {
    const value = dict.objectForKey(key);
    return value ? ObjC.unwrap(value) : null;
  };
  const owner = String(get("kCGWindowOwnerName") || "");
  const layer = Number(get("kCGWindowLayer"));
  if (owner !== "Figma" || layer !== 0) continue;
  const bounds = ObjC.deepUnwrap(dict.objectForKey("kCGWindowBounds"));
  out.push({
    id: Number(get("kCGWindowNumber")),
    name: String(get("kCGWindowName") || ""),
    owner,
    onScreen: Boolean(get("kCGWindowIsOnscreen")),
    bounds: {
      x: Number(bounds.X),
      y: Number(bounds.Y),
      width: Number(bounds.Width),
      height: Number(bounds.Height),
    },
  });
}
JSON.stringify(out);
`;

function safeSegment(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "figma"
  );
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Desktop screenshot payload is not a valid PNG.",
    );
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Desktop screenshot dimensions ${width}×${height} are invalid.`,
    );
  }
  return { width, height };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory())
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `${directory} is not a directory.`,
    );
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `${directory} is not owned by the current user.`,
    );
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

const directoryLocks = new Map<string, Promise<void>>();

async function withDirectoryLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(directory);
  const previous = directoryLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  directoryLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (directoryLocks.get(key) === tail) directoryLocks.delete(key);
  }
}

export function selectFigmaWindow(
  windows: DesktopWindow[],
  fileName: string,
): DesktopWindow {
  const exact = windows.filter((window) => window.name === fileName);
  if (exact.length !== 1)
    throw new McpFigError(
      "NOT_CONNECTED",
      exact.length === 0
        ? `No Figma Desktop window matches ${fileName}.`
        : `Multiple Figma Desktop windows match ${fileName}; close or rename duplicates before capturing.`,
      {
        retryable: true,
        details: { exactMatchCount: exact.length },
      },
    );
  const window = exact.at(0);
  if (!window)
    throw new McpFigError(
      "INTERNAL_ERROR",
      "Exact Figma window selection returned no candidate.",
    );
  if (!window.onScreen)
    throw new McpFigError(
      "NOT_CONNECTED",
      `The Figma Desktop window for ${fileName} is minimized or off-screen.`,
      { retryable: true },
    );
  return window;
}

async function findFigmaWindow(fileName: string): Promise<DesktopWindow> {
  if (process.platform !== "darwin")
    throw new McpFigError(
      "UNSUPPORTED_BY_BRIDGE",
      "Desktop screenshot capture currently requires macOS.",
    );
  let stdout: string;
  try {
    ({ stdout } = await execFile("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      WINDOW_SCRIPT,
    ]));
  } catch (error) {
    throw new McpFigError(
      "UNSUPPORTED_BY_BRIDGE",
      "Could not enumerate Figma Desktop windows through CoreGraphics.",
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
  const windows = JSON.parse(stdout.trim() || "[]") as DesktopWindow[];
  return selectFigmaWindow(windows, fileName);
}

async function captureWindow(windowId: number, path: string): Promise<void> {
  try {
    await execFile("/usr/sbin/screencapture", [
      "-x",
      "-o",
      "-l",
      String(windowId),
      path,
    ]);
  } catch (error) {
    throw new McpFigError(
      "UNSUPPORTED_BY_BRIDGE",
      "macOS could not capture the Figma window. Unlock the display and grant Screen Recording permission to the Hermes gateway process.",
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

async function resizePng(
  path: string,
  width: number,
  height: number,
): Promise<void> {
  await execFile("/usr/bin/sips", [
    "--resampleHeightWidth",
    String(height),
    String(width),
    path,
  ]);
}

export function defaultScreenshotDirectory(): string {
  return join(homedir(), ".mcp-fig", "screenshots");
}

export async function captureFigmaDesktop(
  preparation: ScreenshotPreparation,
  options: DesktopScreenshotOptions,
  dependencies: DesktopScreenshotDependencies = {},
): Promise<ScreenshotArtifact> {
  if (
    !Number.isInteger(options.maxBytes) ||
    options.maxBytes < 64_000 ||
    options.maxBytes > SCREENSHOT_MAX_BYTES
  )
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Screenshot maxBytes must be an integer from 64000 through ${SCREENSHOT_MAX_BYTES}.`,
    );
  if (
    !Number.isFinite(options.scale) ||
    options.scale < 0.25 ||
    options.scale > 1
  )
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Desktop screenshot scale must be from 0.25 through 1.",
    );
  if (
    !Number.isInteger(options.delayMs) ||
    options.delayMs < 0 ||
    options.delayMs > 2_000
  )
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "Desktop screenshot delayMs must be an integer from 0 through 2000.",
    );

  const directory = dependencies.directory ?? defaultScreenshotDirectory();
  await ensurePrivateDirectory(directory);
  const tempDirectory = await mkdtemp(
    join(dependencies.tempRoot ?? tmpdir(), "mcp-fig-screenshot-"),
  );
  const tempPath = join(tempDirectory, "capture.png");
  try {
    if (options.delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const window = await (dependencies.findWindow ?? findFigmaWindow)(
      preparation.fileName,
    );
    await (dependencies.captureWindow ?? captureWindow)(window.id, tempPath);
    let bytes = await readFile(tempPath);
    let dimensions = pngDimensions(bytes);
    if (options.scale < 1) {
      const width = Math.max(1, Math.round(dimensions.width * options.scale));
      const height = Math.max(1, Math.round(dimensions.height * options.scale));
      await (dependencies.resizePng ?? resizePng)(tempPath, width, height);
      bytes = await readFile(tempPath);
      dimensions = pngDimensions(bytes);
    }
    if (bytes.byteLength > options.maxBytes)
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Desktop screenshot is ${bytes.byteLength} bytes, above the requested ${options.maxBytes}-byte cap; lower scale or raise maxBytes.`,
      );
    const timestamp = (dependencies.now ?? new Date())
      .toISOString()
      .replace(/[:.]/g, "-");
    const randomId = dependencies.randomId ?? randomUUID;
    const filename = `${safeSegment(preparation.fileName)}-${safeSegment(String(preparation.scope))}-${timestamp}-${safeSegment(randomId().slice(0, 8))}.png`;
    const directoryPath = resolve(directory);
    const candidatePath = resolve(directoryPath, filename);
    if (!candidatePath.startsWith(`${directoryPath}${sep}`))
      throw new McpFigError(
        "INVALID_ARGUMENT",
        "Screenshot artifact path escapes the configured directory.",
      );
    const maxDirectoryBytes =
      dependencies.maxDirectoryBytes ?? SCREENSHOT_DIRECTORY_MAX_BYTES;
    const path = await withDirectoryLock(directoryPath, async () => {
      if (
        (await directoryBytes(directoryPath)) + bytes.byteLength >
        maxDirectoryBytes
      )
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Screenshot directory quota would exceed ${maxDirectoryBytes} bytes; remove old artifacts first.`,
        );
      let created = false;
      try {
        const handle = await open(candidatePath, "wx", 0o600);
        created = true;
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (created) await rm(candidatePath, { force: true });
        throw error;
      }
      return candidatePath;
    });
    return {
      scope: preparation.scope,
      focusNodeIds: preparation.focusNodeIds,
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
      scale: options.scale,
      path,
      window,
      viewportBounds: preparation.viewportBounds,
      ...(preparation.focusBounds
        ? { focusBounds: preparation.focusBounds }
        : {}),
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
