import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { InMemoryFigmaBridge } from "../dist/bridge/in-memory.js";
import { createMcpServer } from "../dist/server.js";

const root = new URL("../", import.meta.url);
const fixture = readJson("tests/fixtures/core-file.json");
const visualWorkflow = readJson(
  "tests/fixtures/auto-layout-visual-workflow.json",
);
const snapshotDirectory = new URL("tests/snapshots/", root);
mkdirSync(snapshotDirectory, { recursive: true });

const server = createMcpServer(
  {
    version: "0.0.0-snapshot",
    profiles: ["core"],
    logLevel: "error",
  },
  { bridge: new InMemoryFigmaBridge([fixture], fixture.key) },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({
  name: "mcp-fig-snapshot-generator",
  version: "0.0.0",
});

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = (await client.listTools()).tools;
  const schemaSnapshot = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    }));
  writeJson("core-tool-schemas.json", schemaSnapshot);

  await call("figma_layout", {
    action: "batch",
    operations: visualWorkflow.operations,
  });
  const inspected = await call("figma_layout", {
    action: "inspect",
    nodeIds: visualWorkflow.nodeIds,
  });
  writeJson("auto-layout-structural-visual.json", {
    layouts: inspected.layouts,
  });

  process.stdout.write(
    `updated ${tools.length} tool schemas and Auto Layout structural snapshot\n`,
  );
} finally {
  await client.close();
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, root), "utf8"));
}

function writeJson(filename, value) {
  writeFileSync(
    new URL(filename, snapshotDirectory),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function call(name, args) {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }),
  );
  if (result.isError) {
    throw new Error(`Snapshot workflow failed for ${name}`);
  }
  const text = result.content.find((item) => item.type === "text");
  const payload = JSON.parse(text?.type === "text" ? text.text : "{}");
  return payload.data;
}
