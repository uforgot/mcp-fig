import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_IMAGE_IMPORT_BYTES,
  readImageSource,
  sniffImageMime,
} from "../src/images/import.js";

const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("image import source policy", () => {
  it("reads owner-local PNG bytes by signature", async () => {
    const directory = await mkdtemp(join(homedir(), ".mcp-fig-image-test-"));
    cleanup.push(directory);
    const path = join(directory, "input.bin");
    await writeFile(
      path,
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    );
    await expect(
      readImageSource({ type: "local", path }),
    ).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it("keeps the maximum raw payload below the broker JSON cap", () => {
    const envelope = JSON.stringify({
      clientId: "image-import-test",
      method: "node.image",
      params: {
        action: "import",
        mimeType: "image/png",
        dataBase64: Buffer.alloc(MAX_IMAGE_IMPORT_BYTES).toString("base64"),
      },
      options: { fileKey: "local:0:0", timeoutMs: 15_000 },
    });
    expect(Buffer.byteLength(envelope)).toBeLessThan(1_000_000);
  });

  it("rejects malformed, outside-home, private URL, and oversized payloads", async () => {
    expect(() => sniffImageMime(Buffer.from("not-image"))).toThrow(
      /PNG, JPEG, or GIF/u,
    );
    const outside = await mkdtemp(join(tmpdir(), "mcp-fig-outside-"));
    cleanup.push(outside);
    const outsidePath = join(outside, "x.png");
    await writeFile(
      outsidePath,
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await expect(
      readImageSource({ type: "local", path: outsidePath }),
    ).rejects.toThrow(/owner home/u);
    await expect(
      readImageSource({ type: "url", url: "https://127.0.0.1/image.png" }),
    ).rejects.toThrow(/private or reserved/u);

    const directory = await mkdtemp(join(homedir(), ".mcp-fig-image-test-"));
    cleanup.push(directory);
    const oversized = join(directory, "large.png");
    await writeFile(oversized, Buffer.alloc(MAX_IMAGE_IMPORT_BYTES + 1));
    await expect(
      readImageSource({ type: "local", path: oversized }),
    ).rejects.toThrow(/exceeds/u);
  });
});
