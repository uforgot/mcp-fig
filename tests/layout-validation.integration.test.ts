import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryFigmaBridge } from "../src/bridge/in-memory.js";
import type { FigmaFileFixture } from "../src/bridge/types.js";
import { createMcpServer } from "../src/server.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/layout-invalid-file.json", import.meta.url),
    "utf8",
  ),
) as FigmaFileFixture;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function createClient(): Promise<Client> {
  const server = createMcpServer(
    {
      version: "0.0.0-test",
      profiles: ["core"],
      logLevel: "error",
    },
    { bridge: new InMemoryFigmaBridge([fixture], fixture.key) },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "mcp-fig-layout-validation-test",
    version: "0.0.0",
  });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: "figma_layout", arguments: args }),
  );
  const text = result.content.find((item) => item.type === "text");
  return {
    result,
    payload: JSON.parse(text?.type === "text" ? text.text : "{}"),
  };
}

const repairableCodes = [
  "FILL_IN_HUG_PARENT_HORIZONTAL",
  "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
  "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
];

describe("Auto Layout validation and safe repair", () => {
  it("finds overflow, sizing conflicts, and invalid HUG/FILL without false positives", async () => {
    const client = await createClient();
    const result = await call(client, {
      action: "validate",
      nodeIds: ["10:0", "11:0", "12:0", "13:0", "14:0"],
    });

    expect(result.payload.data.valid).toBe(false);
    expect(
      result.payload.data.issues.map(
        (issue: { code: string; nodeId: string }) =>
          `${issue.code}:${issue.nodeId}`,
      ),
    ).toEqual([
      "AUTO_LAYOUT_OVERFLOW_HORIZONTAL:10:0",
      "FILL_IN_HUG_PARENT_HORIZONTAL:11:1",
      "HUG_WITHOUT_AUTO_LAYOUT_PARENT:12:0",
      "FILL_WITHOUT_AUTO_LAYOUT_PARENT:12:0",
      "MIN_MAX_CONFLICT_WIDTH:13:0",
    ]);
    expect(result.payload.data.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AUTO_LAYOUT_OVERFLOW_HORIZONTAL",
          repairable: false,
          message: expect.stringContaining("horizontal"),
          details: expect.objectContaining({ overflowBy: 72 }),
        }),
        expect.objectContaining({
          code: "FILL_IN_HUG_PARENT_HORIZONTAL",
          repairable: true,
          message: expect.any(String),
        }),
      ]),
    );

    const valid = await call(client, {
      action: "validate",
      nodeIds: ["14:0"],
    });
    expect(valid.payload.data).toEqual({ valid: true, issues: [] });
  });

  it("previews deterministic repairs and clears each selected issue after apply", async () => {
    const client = await createClient();
    const input = {
      action: "repair",
      nodeIds: ["11:0", "12:0"],
      issueCodes: repairableCodes,
    };

    const preview = await call(client, { ...input, dryRun: true });
    expect(preview.payload.data.dryRun).toBe(true);
    expect(preview.payload.data.repairs).toEqual([
      {
        issueCode: "FILL_IN_HUG_PARENT_HORIZONTAL",
        nodeId: "11:1",
        reason: expect.any(String),
        changes: [
          {
            property: "layoutSizingHorizontal",
            from: "FILL",
            to: "FIXED",
          },
        ],
      },
      {
        issueCode: "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
        nodeId: "12:0",
        reason: expect.any(String),
        changes: [
          {
            property: "layoutSizingHorizontal",
            from: "HUG",
            to: "FIXED",
          },
        ],
      },
      {
        issueCode: "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
        nodeId: "12:0",
        reason: expect.any(String),
        changes: [
          {
            property: "layoutSizingVertical",
            from: "FILL",
            to: "FIXED",
          },
        ],
      },
    ]);
    expect(preview.payload.data.afterValidation).toEqual({
      valid: true,
      issues: [],
    });

    const unchanged = await call(client, {
      action: "validate",
      nodeIds: ["11:0", "12:0"],
    });
    expect(unchanged.payload.data.issues).toHaveLength(3);

    const applied = await call(client, input);
    expect(applied.payload.data.repairs).toEqual(preview.payload.data.repairs);
    expect(applied.payload.data.afterValidation).toEqual({
      valid: true,
      issues: [],
    });

    const revalidated = await call(client, {
      action: "validate",
      nodeIds: ["11:0", "12:0"],
    });
    expect(revalidated.payload.data).toEqual({ valid: true, issues: [] });
  });

  it("rejects an unsafe repair set atomically", async () => {
    const client = await createClient();
    const rejected = await call(client, {
      action: "repair",
      nodeIds: ["10:0", "12:0"],
      issueCodes: [
        "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
        "AUTO_LAYOUT_OVERFLOW_HORIZONTAL",
      ],
    });

    expect(rejected.result.isError).toBe(true);
    expect(rejected.payload.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: {
        unsafeIssueCodes: ["AUTO_LAYOUT_OVERFLOW_HORIZONTAL"],
      },
    });

    const unchanged = await call(client, {
      action: "validate",
      nodeIds: ["12:0"],
    });
    expect(unchanged.payload.data.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "HUG_WITHOUT_AUTO_LAYOUT_PARENT" }),
        expect.objectContaining({ code: "FILL_WITHOUT_AUTO_LAYOUT_PARENT" }),
      ]),
    );
  });
});
