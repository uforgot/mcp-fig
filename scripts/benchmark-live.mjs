import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const target = argument("target");
if (!new Set(["mcp-fig", "legacy"]).has(target)) {
  throw new Error("Use --target mcp-fig or --target legacy.");
}
const samples = Number(argument("samples", "20"));
const startupSamples = Number(argument("startup-samples", "5"));
const outputPath = argument("output", `benchmark/raw/${target}.json`);
const fixturePath = argument("fixture", "benchmark/raw/live-fixture.json");
const createFixture = process.argv.includes("--create-fixture");
const cleanup = process.argv.includes("--cleanup");
const readyTimeoutMs = Number(argument("ready-timeout-ms", "120000"));
const legacyVersion = "1.37.1";
const pluginToken = process.env.MCP_FIG_PLUGIN_TOKEN;
if (target === "mcp-fig" && !pluginToken) {
  throw new Error("MCP_FIG_PLUGIN_TOKEN is required for the mcp-fig target.");
}
if (target === "legacy" && !process.env.FIGMA_TOKEN) {
  throw new Error("FIGMA_TOKEN is required for the legacy target.");
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * ratio) - 1];
}

function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const list = groups.get(record.case) ?? [];
    list.push(record);
    groups.set(record.case, list);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([name, list]) => {
      const durations = list.map((entry) => entry.durationMs);
      return [
        name,
        {
          samples: list.length,
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
          requestBytesP50: percentile(
            list.map((entry) => entry.requestBytes),
            0.5,
          ),
          responseBytesP50: percentile(
            list.map((entry) => entry.responseBytes),
            0.5,
          ),
          callsPerSample: list[0]?.calls ?? 1,
        },
      ];
    }),
  );
}

function parseToolPayload(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function launch() {
  const isMcpFig = target === "mcp-fig";
  const transport = new StdioClientTransport({
    command: isMcpFig ? process.execPath : "npx",
    args: isMcpFig
      ? ["dist/index.js"]
      : ["-y", `figma-console-mcp@${legacyVersion}`],
    env: isMcpFig
      ? {
          ...process.env,
          MCP_FIG_BRIDGE: "desktop-plugin",
          MCP_FIG_PLUGIN_TOKEN: pluginToken,
          MCP_FIG_PLUGIN_PORT: "3847",
          MCP_FIG_LOG_LEVEL: "error",
        }
      : {
          ...process.env,
          FIGMA_ACCESS_TOKEN: process.env.FIGMA_TOKEN,
          ENABLE_MCP_APPS: "false",
        },
    stderr: "pipe",
  });
  const client = new Client({
    name: "mcp-fig-live-benchmark",
    version: "1.0.0",
  });
  const processStarted = performance.now();
  await client.connect(transport);
  const initialized = performance.now();
  const toolsStarted = performance.now();
  const tools = await client.listTools();
  const toolsCompleted = performance.now();
  return {
    client,
    processStarted,
    initialized,
    toolsCompleted,
    startup: {
      initializeMs: initialized - processStarted,
      toolsListMs: toolsCompleted - toolsStarted,
      processToToolsCompleteMs: toolsCompleted - processStarted,
      toolCount: tools.tools.length,
      schemaBytes: bytes(tools.tools),
    },
  };
}

async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const payload = parseToolPayload(result);
  if (result.isError || payload?.ok === false) {
    throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
  }
  return { result, payload };
}

function connected(payload) {
  if (target === "mcp-fig") return payload?.data?.connected === true;
  const textPayload = payload?.content ? parseToolPayload(payload) : payload;
  const legacy =
    typeof textPayload === "string" ? JSON.parse(textPayload) : textPayload;
  return legacy?.transport?.active === "websocket";
}

async function waitReady(client, processStarted) {
  const deadline = performance.now() + readyTimeoutMs;
  let last;
  while (performance.now() < deadline) {
    try {
      const statusName =
        target === "mcp-fig" ? "figma_connection" : "figma_get_status";
      const args = target === "mcp-fig" ? { action: "status" } : {};
      last = await client.callTool({ name: statusName, arguments: args });
      const payload = parseToolPayload(last);
      if (connected(payload)) return performance.now() - processStarted;
    } catch {
      // The plugin can be between reconnect attempts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Plugin did not become ready within ${readyTimeoutMs}ms: ${JSON.stringify(parseToolPayload(last))}`,
  );
}

async function measure(client, caseName, calls) {
  const started = performance.now();
  let requestBytes = 0;
  let responseBytes = 0;
  const payloads = [];
  for (const call of calls) {
    requestBytes += bytes(call);
    const response = await tool(client, call.name, call.arguments);
    responseBytes += bytes(response.result);
    payloads.push(response.payload);
  }
  return {
    case: caseName,
    durationMs: performance.now() - started,
    requestBytes,
    responseBytes,
    calls: calls.length,
    payloads,
  };
}

function data(payload) {
  return payload?.data ?? payload;
}

function findFirstPage(node) {
  if (node?.type === "PAGE") return node;
  for (const child of node?.children ?? []) {
    const found = findFirstPage(child);
    if (found) return found;
  }
  return null;
}

async function createMcpFigFixture(client) {
  const document = await tool(client, "figma_document", { action: "inspect" });
  const page = findFirstPage(data(document.payload).document);
  if (!page) throw new Error("No Figma page found for benchmark fixture.");
  const suffix = Date.now().toString(36);
  const frameResult = await tool(client, "figma_node", {
    action: "create",
    parentId: page.id,
    nodeType: "FRAME",
    name: `MCP Fig Benchmark ${suffix}`,
    props: { x: 0, y: 0, width: 320, height: 240 },
  });
  const frame = data(frameResult.payload).nodes[0];
  const nodeResult = await tool(client, "figma_node", {
    action: "create",
    parentId: frame.id,
    nodeType: "RECTANGLE",
    name: `Benchmark Node ${suffix}`,
    props: { width: 120, height: 80 },
  });
  const node = data(nodeResult.payload).nodes[0];
  const componentResult = await tool(client, "figma_node", {
    action: "create",
    parentId: page.id,
    nodeType: "COMPONENT",
    name: `Benchmark Component ${suffix}`,
    props: { x: 380, y: 0, width: 120, height: 48 },
  });
  const component = data(componentResult.payload).nodes[0];
  await tool(client, "figma_layout", {
    action: "apply",
    nodeIds: [frame.id],
    layout: { layoutMode: "VERTICAL", gap: 8, padding: 12 },
  });
  return {
    createdAt: new Date().toISOString(),
    pageId: page.id,
    frameId: frame.id,
    nodeId: node.id,
    componentId: component.id,
    componentKey: component.componentKey,
    componentName: component.name,
  };
}

async function deleteMcpFigNodes(client, nodeIds) {
  if (nodeIds.length === 0) return;
  const preview = await tool(client, "figma_node", {
    action: "delete",
    nodeIds,
    dryRun: true,
  });
  const confirmationToken = data(preview.payload).confirmationToken;
  await tool(client, "figma_node", {
    action: "delete",
    nodeIds,
    confirm: confirmationToken,
  });
}

function legacyExecute(code) {
  return { name: "figma_execute", arguments: { code, timeout: 5000 } };
}

async function runCases(client, fixture) {
  const records = [];
  const createdInstanceIds = [];
  for (let index = -3; index < samples; index += 1) {
    const keep = index >= 0;
    const suffix = index % 2 === 0 ? "A" : "B";
    const cases =
      target === "mcp-fig"
        ? [
            [
              "selection",
              [{ name: "figma_selection", arguments: { action: "inspect" } }],
            ],
            [
              "node_read",
              [
                {
                  name: "figma_node",
                  arguments: { action: "get", nodeIds: [fixture.nodeId] },
                },
              ],
            ],
            [
              "document_summary",
              [{ name: "figma_document", arguments: { action: "summary" } }],
            ],
            [
              "single_write",
              [
                {
                  name: "figma_node",
                  arguments: {
                    action: "update",
                    nodeIds: [fixture.nodeId],
                    patch: { name: `Benchmark Node ${suffix}` },
                  },
                },
              ],
            ],
            [
              "layout_batch_validate",
              [
                {
                  name: "figma_layout",
                  arguments: {
                    action: "batch",
                    operations: [
                      {
                        op: "apply",
                        nodeIds: [fixture.frameId],
                        layout: {
                          layoutMode: "VERTICAL",
                          gap: suffix === "A" ? 8 : 9,
                          padding: 12,
                        },
                      },
                      {
                        op: "sizing",
                        nodeIds: [fixture.nodeId],
                        sizing: { horizontal: "FIXED", vertical: "FIXED" },
                      },
                    ],
                  },
                },
                {
                  name: "figma_layout",
                  arguments: { action: "validate", nodeIds: [fixture.frameId] },
                },
              ],
            ],
            [
              "component_write",
              [
                {
                  name: "figma_component",
                  arguments: {
                    action: "set_description",
                    componentId: fixture.componentId,
                    description: `benchmark-${suffix}`,
                  },
                },
              ],
            ],
            [
              "tokens_read",
              [{ name: "figma_tokens", arguments: { action: "inspect" } }],
            ],
          ]
        : [
            ["selection", [{ name: "figma_get_selection", arguments: {} }]],
            [
              "node_read",
              [
                legacyExecute(
                  `const n=await figma.getNodeByIdAsync(${JSON.stringify(fixture.nodeId)}); return n?{id:n.id,type:n.type,name:n.name,parentId:n.parent?.id,width:n.width,height:n.height}:null;`,
                ),
              ],
            ],
            [
              "document_summary",
              [
                legacyExecute(
                  "return {fileKey:figma.fileKey,fileName:figma.root.name,pageId:figma.currentPage.id,pageName:figma.currentPage.name,topLevelNodeCount:figma.currentPage.children.length};",
                ),
              ],
            ],
            [
              "single_write",
              [
                {
                  name: "figma_rename_node",
                  arguments: {
                    nodeId: fixture.nodeId,
                    newName: `Benchmark Node ${suffix}`,
                  },
                },
              ],
            ],
            [
              "layout_batch_validate",
              [
                legacyExecute(
                  `const f=await figma.getNodeByIdAsync(${JSON.stringify(fixture.frameId)}); const n=await figma.getNodeByIdAsync(${JSON.stringify(fixture.nodeId)}); f.layoutMode='VERTICAL'; f.itemSpacing=${suffix === "A" ? 8 : 9}; f.paddingTop=f.paddingRight=f.paddingBottom=f.paddingLeft=12; n.layoutSizingHorizontal='FIXED'; n.layoutSizingVertical='FIXED'; return {frameId:f.id,nodeId:n.id};`,
                ),
                legacyExecute(
                  `const f=await figma.getNodeByIdAsync(${JSON.stringify(fixture.frameId)}); return {valid:f.layoutMode==='VERTICAL',layoutMode:f.layoutMode,itemSpacing:f.itemSpacing,childCount:f.children.length};`,
                ),
              ],
            ],
            [
              "component_write",
              [
                legacyExecute(
                  `const c=await figma.getNodeByIdAsync(${JSON.stringify(fixture.componentId)}); c.description=${JSON.stringify(`benchmark-${suffix}`)}; return {id:c.id,description:c.description};`,
                ),
              ],
            ],
            [
              "tokens_read",
              [
                {
                  name: "figma_get_variables",
                  arguments: {
                    format: "summary",
                    verbosity: "summary",
                    refreshCache: false,
                  },
                },
              ],
            ],
          ];
    for (const [caseName, calls] of cases) {
      const record = await measure(client, caseName, calls);
      if (keep) records.push({ ...record, sample: index });
    }
    const instanceCall =
      target === "mcp-fig"
        ? {
            name: "figma_instance",
            arguments: {
              action: "create",
              componentId: fixture.componentId,
              parentId: fixture.pageId,
              x: 540 + index * 4,
              y: 0,
            },
          }
        : legacyExecute(
            `const c=await figma.getNodeByIdAsync(${JSON.stringify(fixture.componentId)}); const i=c.createInstance(); figma.currentPage.appendChild(i); i.x=${540 + index * 4}; i.y=0; return {id:i.id};`,
          );
    const instanceRecord = await measure(client, "instance_write", [
      instanceCall,
    ]);
    const instancePayload = data(instanceRecord.payloads[0]);
    const instanceId =
      target === "mcp-fig"
        ? instancePayload.instances?.[0]?.id
        : (instancePayload?.result?.id ?? instancePayload?.id);
    if (instanceId) createdInstanceIds.push(instanceId);
    if (keep) records.push({ ...instanceRecord, sample: index });
  }
  return { records, createdInstanceIds };
}

const startup = [];
await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(fixturePath), { recursive: true });
let active;
for (let index = 0; index < startupSamples; index += 1) {
  const launched = await launch();
  const handshakeReadyMs = await waitReady(
    launched.client,
    launched.processStarted,
  );
  startup.push({ sample: index, ...launched.startup, handshakeReadyMs });
  if (index === startupSamples - 1) active = launched;
  else {
    await launched.client.close();
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

let fixture;
if (createFixture) {
  if (target !== "mcp-fig")
    throw new Error("--create-fixture requires --target mcp-fig.");
  fixture = await createMcpFigFixture(active.client);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
} else {
  fixture = JSON.parse(await readFile(fixturePath, "utf8"));
}

const { records, createdInstanceIds } = await runCases(active.client, fixture);
let phaseMetrics = [];
if (target === "mcp-fig") {
  const response = await fetch("http://127.0.0.1:3847/v1/metrics", {
    headers: { authorization: `Bearer ${pluginToken}` },
  });
  if (!response.ok)
    throw new Error(`Metrics endpoint failed: ${response.status}`);
  phaseMetrics = (await response.json()).metrics;
}
if (cleanup) {
  if (target === "mcp-fig") {
    await deleteMcpFigNodes(active.client, [
      ...createdInstanceIds,
      fixture.frameId,
      fixture.componentId,
    ]);
  } else {
    await tool(active.client, "figma_execute", {
      code: `for (const id of ${JSON.stringify([...createdInstanceIds, fixture.frameId, fixture.componentId])}) { const node=await figma.getNodeByIdAsync(id); if (node) node.remove(); } return {removed:true};`,
      timeout: 5000,
    });
  }
}
await active.client.close();

const result = {
  metadata: {
    target,
    comparatorVersion: target === "legacy" ? legacyVersion : null,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    samples,
    startupSamples,
    fixture,
  },
  startup,
  startupSummary: {
    initializeP50Ms: percentile(
      startup.map((entry) => entry.initializeMs),
      0.5,
    ),
    initializeP95Ms: percentile(
      startup.map((entry) => entry.initializeMs),
      0.95,
    ),
    toolsListP50Ms: percentile(
      startup.map((entry) => entry.toolsListMs),
      0.5,
    ),
    toolsListP95Ms: percentile(
      startup.map((entry) => entry.toolsListMs),
      0.95,
    ),
    handshakeReadyP50Ms: percentile(
      startup.map((entry) => entry.handshakeReadyMs),
      0.5,
    ),
    handshakeReadyP95Ms: percentile(
      startup.map((entry) => entry.handshakeReadyMs),
      0.95,
    ),
    toolCount: startup[0]?.toolCount,
    schemaBytes: startup[0]?.schemaBytes,
  },
  summary: summarize(records),
  samples: records,
  phaseMetrics,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      outputPath,
      startupSummary: result.startupSummary,
      summary: result.summary,
    },
    null,
    2,
  ),
);
