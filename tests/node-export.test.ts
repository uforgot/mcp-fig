import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveNodeExports } from "../src/artifacts/node-export.js";
import type { NodeExportPayload } from "../src/bridge/types.js";

const directories: string[] = [];
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const pdf = Buffer.from("%PDF-1.7\n");

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-fig-export-"));
  directories.push(directory);
  return directory;
}

function payload(
  overrides: Partial<NodeExportPayload> = {},
): NodeExportPayload {
  return {
    nodeId: "28:26",
    nodeName: "MCP Fig Summary",
    format: "PNG",
    mimeType: "image/png",
    byteLength: png.byteLength,
    dataBase64: png.toString("base64"),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("node export artifacts", () => {
  it("writes verified bytes to an owner-only artifact", async () => {
    const directory = await temporaryDirectory();
    const [artifact] = await saveNodeExports([payload()], {
      directory,
      now: new Date("2026-07-27T12:00:00.000Z"),
    });

    expect(artifact).toMatchObject({
      nodeId: "28:26",
      nodeName: "MCP Fig Summary",
      format: "PNG",
      mimeType: "image/png",
      byteLength: 8,
    });
    expect(artifact?.path).toMatch(/MCP-Fig-Summary-28-26-.*\.png$/u);
    await expect(readFile(artifact?.path ?? "")).resolves.toEqual(png);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(artifact?.path ?? "")).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed base64 metadata and invalid signatures", async () => {
    const directory = await temporaryDirectory();

    await expect(
      saveNodeExports([payload({ byteLength: 9 })], { directory }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      saveNodeExports(
        [
          payload({
            byteLength: 4,
            dataBase64: Buffer.from("nope").toString("base64"),
          }),
        ],
        { directory },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      saveNodeExports([payload({ mimeType: "image/jpeg" })], { directory }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ["JPG", "image/jpeg", jpg, "jpg"],
    ["SVG", "image/svg+xml", svg, "svg"],
    ["PDF", "application/pdf", pdf, "pdf"],
  ] as const)(
    "writes verified %s signatures",
    async (format, mimeType, bytes, extension) => {
      const directory = await temporaryDirectory();
      const [artifact] = await saveNodeExports(
        [
          payload({
            format,
            mimeType,
            byteLength: bytes.byteLength,
            dataBase64: bytes.toString("base64"),
          }),
        ],
        { directory },
      );

      expect(artifact?.path).toMatch(new RegExp(`\\.${extension}$`, "u"));
      await expect(readFile(artifact?.path ?? "")).resolves.toEqual(bytes);
    },
  );

  it("prevalidates batches, rolls back write failures, and enforces quota", async () => {
    const directory = await temporaryDirectory();
    const invalid = payload({
      byteLength: 4,
      dataBase64: Buffer.from("nope").toString("base64"),
    });

    await expect(
      saveNodeExports([payload(), invalid], { directory }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readdir(directory)).toEqual([]);

    await expect(
      saveNodeExports([payload(), payload()], {
        directory,
        now: new Date("2026-07-27T12:00:00.000Z"),
        randomId: () => "same-id",
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readdir(directory)).toEqual([]);

    await expect(
      saveNodeExports([payload()], { directory, maxDirectoryBytes: 7 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readdir(directory)).toEqual([]);
  });
});
