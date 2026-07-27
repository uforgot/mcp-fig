import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureFigmaDesktop,
  type DesktopWindow,
  selectFigmaWindow,
} from "../src/artifacts/screenshot.js";
import type { ScreenshotPreparation } from "../src/bridge/types.js";

const directories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function png(width: number, height: number, byteLength = 24): Buffer {
  const bytes = Buffer.alloc(Math.max(24, byteLength));
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const preparation: ScreenshotPreparation = {
  fileName: "MCP Fig Visual Proof",
  pageId: "1:0",
  scope: "viewport",
  focusNodeIds: [],
  viewportBounds: { x: 10, y: 20, width: 1200, height: 800 },
  leaseId: "capture-test-lease",
};

const window = {
  id: 42,
  name: "MCP Fig Visual Proof",
  owner: "Figma",
  onScreen: true,
  bounds: { x: 100, y: 200, width: 1400, height: 900 },
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Desktop screenshot artifacts", () => {
  it("fails closed for duplicate-title and off-screen Figma windows", () => {
    const visible = window as DesktopWindow;
    expect(() =>
      selectFigmaWindow(
        [visible, { ...visible, id: 43 }],
        preparation.fileName,
      ),
    ).toThrow(/Multiple Figma Desktop windows/);
    expect(() =>
      selectFigmaWindow(
        [{ ...visible, onScreen: false }],
        preparation.fileName,
      ),
    ).toThrow(/minimized or off-screen/);
  });

  it("writes a bounded owner-only PNG with proof metadata", async () => {
    const directory = await temporaryDirectory("mcp-fig-screenshot-output-");
    const tempRoot = await temporaryDirectory("mcp-fig-screenshot-temp-");
    const bytes = png(1400, 900);

    const artifact = await captureFigmaDesktop(
      preparation,
      { scale: 1, maxBytes: 64_000, delayMs: 0 },
      {
        directory,
        tempRoot,
        now: new Date("2026-07-27T12:00:00.000Z"),
        randomId: () => "fixed-id",
        findWindow: async () => window,
        captureWindow: async (_windowId, path) => writeFile(path, bytes),
      },
    );

    expect(artifact).toMatchObject({
      scope: "viewport",
      mimeType: "image/png",
      byteLength: 24,
      width: 1400,
      height: 900,
      scale: 1,
      window,
    });
    expect(artifact.path).toMatch(/MCP-Fig-Visual-Proof-viewport-.*\.png$/u);
    await expect(readFile(artifact.path)).resolves.toEqual(bytes);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("enforces payload cap before artifact creation and cleans temporary bytes", async () => {
    const directory = await temporaryDirectory(
      "mcp-fig-screenshot-cap-output-",
    );
    const tempRoot = await temporaryDirectory("mcp-fig-screenshot-cap-temp-");

    await expect(
      captureFigmaDesktop(
        preparation,
        { scale: 1, maxBytes: 64_000, delayMs: 0 },
        {
          directory,
          tempRoot,
          findWindow: async () => window,
          captureWindow: async (_windowId, path) =>
            writeFile(path, png(1400, 900, 64_001)),
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readdir(directory)).toEqual([]);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("preserves an existing artifact on an exclusive-create collision", async () => {
    const directory = await temporaryDirectory(
      "mcp-fig-screenshot-collision-output-",
    );
    const tempRoot = await temporaryDirectory(
      "mcp-fig-screenshot-collision-temp-",
    );
    const bytes = png(1400, 900);
    const dependencies = {
      directory,
      tempRoot,
      now: new Date("2026-07-27T12:00:00.000Z"),
      randomId: () => "same-id",
      findWindow: async () => window,
      captureWindow: async (_windowId: number, path: string) =>
        writeFile(path, bytes),
    };
    const first = await captureFigmaDesktop(
      preparation,
      { scale: 1, maxBytes: 64_000, delayMs: 0 },
      dependencies,
    );

    await expect(
      captureFigmaDesktop(
        preparation,
        { scale: 1, maxBytes: 64_000, delayMs: 0 },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(first.path)).resolves.toEqual(bytes);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("serializes concurrent quota checks and artifact creation", async () => {
    const directory = await temporaryDirectory(
      "mcp-fig-screenshot-quota-output-",
    );
    const tempRoot = await temporaryDirectory("mcp-fig-screenshot-quota-temp-");
    const bytes = png(40, 40, 40);
    let sequence = 0;
    const dependencies = {
      directory,
      tempRoot,
      maxDirectoryBytes: 60,
      randomId: () => `capture-${sequence++}`,
      findWindow: async () => window,
      captureWindow: async (_windowId: number, path: string) =>
        writeFile(path, bytes),
    };

    const outcomes = await Promise.allSettled([
      captureFigmaDesktop(
        preparation,
        { scale: 1, maxBytes: 64_000, delayMs: 0 },
        dependencies,
      ),
      captureFigmaDesktop(
        preparation,
        { scale: 1, maxBytes: 64_000, delayMs: 0 },
        dependencies,
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("recovers a stale cross-process quota lock", async () => {
    const directory = await temporaryDirectory(
      "mcp-fig-screenshot-stale-lock-output-",
    );
    const tempRoot = await temporaryDirectory(
      "mcp-fig-screenshot-stale-lock-temp-",
    );
    const lockPath = `${directory}.quota.lock`;
    await writeFile(lockPath, "stale", { mode: 0o600 });
    const stale = new Date(Date.now() - 31_000);
    await utimes(lockPath, stale, stale);

    const artifact = await captureFigmaDesktop(
      preparation,
      { scale: 1, maxBytes: 64_000, delayMs: 0 },
      {
        directory,
        tempRoot,
        randomId: () => "stale-lock",
        findWindow: async () => window,
        captureWindow: async (_windowId, path) =>
          writeFile(path, png(40, 40, 40)),
      },
    );

    await expect(readFile(artifact.path)).resolves.toHaveLength(40);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid signatures and out-of-contract caps without residue", async () => {
    const directory = await temporaryDirectory(
      "mcp-fig-screenshot-invalid-output-",
    );
    const tempRoot = await temporaryDirectory(
      "mcp-fig-screenshot-invalid-temp-",
    );

    await expect(
      captureFigmaDesktop(
        preparation,
        { scale: 1, maxBytes: 64_000, delayMs: 0 },
        {
          directory,
          tempRoot,
          findWindow: async () => window,
          captureWindow: async (_windowId, path) => writeFile(path, "not png"),
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      captureFigmaDesktop(
        preparation,
        { scale: 1, maxBytes: 63_999, delayMs: 0 },
        { directory, tempRoot },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readdir(directory)).toEqual([]);
    expect(await readdir(tempRoot)).toEqual([]);
  });
});
