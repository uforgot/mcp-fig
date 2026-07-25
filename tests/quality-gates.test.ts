import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryFigmaBridge } from "../src/bridge/in-memory.js";
import type { FigmaFileFixture } from "../src/bridge/types.js";
import { createMcpServer } from "../src/server.js";

interface WorkflowDefinition {
  id: string;
  category: "general" | "auto-layout";
  fixture: "core" | "invalid-layout";
  maxCalls: number;
}

interface BenchmarkFixture {
  thresholds: {
    maxCoreTools: number;
    maxCallsPerWorkflow: number;
    minAutoLayoutTypedRate: number;
  };
  workflows: WorkflowDefinition[];
}

interface ToolData {
  nodeIds: string[];
  components: Array<Record<string, unknown>>;
  instances: Array<Record<string, unknown>>;
  dryRun: boolean;
  appliedOrder: unknown[];
  layouts: Array<{ layout: { layoutMode: string } }>;
  valid: boolean;
  issues: unknown[];
  afterValidation: { valid: boolean };
}

interface ToolPayload {
  data: ToolData;
}

interface Harness {
  client: Client;
  calls: string[];
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    result: ReturnType<typeof CallToolResultSchema.parse>;
    payload: ToolPayload;
  }>;
}

const benchmark = readJson<BenchmarkFixture>(
  "./fixtures/workflow-benchmarks.json",
);
const visualWorkflow = readJson<{
  nodeIds: string[];
  operations: Array<Record<string, unknown>>;
}>("./fixtures/auto-layout-visual-workflow.json");
const fixtures = {
  core: readJson<FigmaFileFixture>("./fixtures/core-file.json"),
  "invalid-layout": readJson<FigmaFileFixture>(
    "./fixtures/layout-invalid-file.json",
  ),
};
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function readJson<Value>(relativePath: string): Value {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Value;
}

async function createHarness(
  fixtureName: WorkflowDefinition["fixture"],
): Promise<Harness> {
  const fixture = fixtures[fixtureName];
  const server = createMcpServer(
    {
      version: "0.0.0-quality-gate",
      profiles: ["core"],
      logLevel: "error",
    },
    { bridge: new InMemoryFigmaBridge([fixture], fixture.key) },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "mcp-fig-quality-gate",
    version: "0.0.0",
  });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const calls: string[] = [];
  return {
    client,
    calls,
    async call(name, args) {
      calls.push(name);
      const result = CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }),
      );
      const text = result.content.find((item) => item.type === "text");
      return {
        result,
        payload: JSON.parse(
          text?.type === "text" ? text.text : "{}",
        ) as ToolPayload,
      };
    },
  };
}

async function applyVisualWorkflow(harness: Harness) {
  const applied = await harness.call("figma_layout", {
    action: "batch",
    operations: visualWorkflow.operations,
  });
  expect(applied.result.isError).not.toBe(true);
  return applied;
}

const runners: Record<
  string,
  (harness: Harness) => Promise<Record<string, unknown> | undefined>
> = {
  async "selection-inspect"(harness) {
    const response = await harness.call("figma_selection", {
      action: "inspect",
    });
    expect(response.payload.data.nodeIds).toEqual(["2:1"]);
  },
  async "component-instance-token"(harness) {
    const searched = await harness.call("figma_component", {
      action: "search",
      query: "button",
    });
    expect(searched.payload.data.components[0]?.nodeId).toBe("3:0");
    const created = await harness.call("figma_instance", {
      action: "create",
      componentId: "3:0",
      parentId: "2:0",
      properties: { State: "Default", Label: "Continue" },
    });
    const instanceId = created.payload.data.instances[0]?.id;
    expect(instanceId).toEqual(expect.any(String));
    if (typeof instanceId !== "string") throw new Error("Instance ID missing");
    await harness.call("figma_instance", {
      action: "update",
      instanceIds: [instanceId],
      properties: { State: "Hover" },
    });
    await harness.call("figma_tokens", { action: "inspect" });
    const bound = await harness.call("figma_tokens", {
      action: "apply",
      operations: [
        {
          op: "bind",
          nodeIds: [instanceId],
          field: "fills",
          variableId: "variable:brand",
        },
      ],
    });
    expect(bound.result.isError).not.toBe(true);
  },
  async "layout-inspect"(harness) {
    const response = await harness.call("figma_layout", {
      action: "inspect",
      nodeIds: visualWorkflow.nodeIds,
    });
    expect(response.payload.data.layouts).toHaveLength(3);
  },
  async "layout-apply-preview"(harness) {
    const response = await harness.call("figma_layout", {
      action: "apply",
      nodeIds: ["4:0"],
      layout: { layoutMode: "VERTICAL", gap: 16, padding: 20 },
      dryRun: true,
    });
    expect(response.payload.data.dryRun).toBe(true);
  },
  async "layout-batch-nested"(harness) {
    const response = await applyVisualWorkflow(harness);
    expect(response.payload.data.appliedOrder).toHaveLength(5);
  },
  async "layout-batch-validate"(harness) {
    await applyVisualWorkflow(harness);
    const validation = await harness.call("figma_layout", {
      action: "validate",
      nodeIds: ["4:0"],
    });
    expect(validation.payload.data).toEqual({ valid: true, issues: [] });
  },
  async "layout-structural-visual"(harness) {
    await applyVisualWorkflow(harness);
    const inspected = await harness.call("figma_layout", {
      action: "inspect",
      nodeIds: visualWorkflow.nodeIds,
    });
    return { layouts: inspected.payload.data.layouts };
  },
  async "layout-validate-valid"(harness) {
    const response = await harness.call("figma_layout", {
      action: "validate",
      nodeIds: ["14:0"],
    });
    expect(response.payload.data).toEqual({ valid: true, issues: [] });
  },
  async "layout-validate-invalid"(harness) {
    const response = await harness.call("figma_layout", {
      action: "validate",
      nodeIds: ["10:0", "11:0", "12:0", "13:0"],
    });
    expect(response.payload.data.valid).toBe(false);
    expect(response.payload.data.issues).toHaveLength(5);
  },
  async "layout-repair-preview"(harness) {
    const response = await harness.call("figma_layout", {
      action: "repair",
      nodeIds: ["11:0", "12:0"],
      issueCodes: [
        "FILL_IN_HUG_PARENT_HORIZONTAL",
        "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
        "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
      ],
      dryRun: true,
    });
    expect(response.payload.data.afterValidation.valid).toBe(true);
  },
  async "layout-repair-apply"(harness) {
    await harness.call("figma_layout", {
      action: "repair",
      nodeIds: ["11:0", "12:0"],
      issueCodes: [
        "FILL_IN_HUG_PARENT_HORIZONTAL",
        "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
        "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
      ],
    });
    const validation = await harness.call("figma_layout", {
      action: "validate",
      nodeIds: ["11:0", "12:0"],
    });
    expect(validation.payload.data).toEqual({ valid: true, issues: [] });
  },
  async "layout-batch-rollback"(harness) {
    const rejected = await harness.call("figma_layout", {
      action: "batch",
      operations: [
        {
          op: "apply",
          nodeIds: ["4:0"],
          layout: { layoutMode: "VERTICAL", gap: 16 },
        },
        {
          op: "sizing",
          nodeIds: ["4:1"],
          sizing: {
            horizontal: "FILL",
            vertical: "HUG",
            minWidth: 500,
            maxWidth: 300,
          },
        },
      ],
    });
    expect(rejected.result.isError).toBe(true);
    const inspected = await harness.call("figma_layout", {
      action: "inspect",
      nodeIds: ["4:0"],
    });
    expect(inspected.payload.data.layouts[0]?.layout.layoutMode).toBe("NONE");
  },
};

describe("MCP Fig quality gates", () => {
  it("keeps the core tool surface below the limit and schema-stable", async () => {
    const harness = await createHarness("core");
    const tools = (await harness.client.listTools()).tools;
    expect(tools.length).toBeLessThanOrEqual(benchmark.thresholds.maxCoreTools);
    expect(tools.map((tool) => tool.name)).not.toContain("figma_execute");
    for (const tool of tools) {
      expect(
        tool.inputSchema.properties?.action,
        `${tool.name} must expose its action discriminator`,
      ).toBeDefined();
      expect(
        Object.keys(tool.inputSchema.properties ?? {}).length,
        `${tool.name} must expose actionable fields`,
      ).toBeGreaterThan(1);
    }

    const actionMismatch = CallToolResultSchema.parse(
      await harness.client.callTool({
        name: "figma_connection",
        arguments: { action: "status", fileKey: "not-valid-for-status" },
      }),
    );
    expect(actionMismatch.isError).toBe(true);
    expect(actionMismatch.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Input validation error"),
    });

    const expected = readJson<unknown>("./snapshots/core-tool-schemas.json");
    const actual = [...tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      }));
    expect(actual).toEqual(expected);
  });

  it("completes representative workflows within call and typed-action limits", async () => {
    const results: Array<{
      id: string;
      category: WorkflowDefinition["category"];
      callCount: number;
      usedRawExecute: boolean;
    }> = [];
    let structuralVisual: Record<string, unknown> | undefined;

    for (const workflow of benchmark.workflows) {
      const harness = await createHarness(workflow.fixture);
      const runner = runners[workflow.id];
      expect(runner, `Missing runner for ${workflow.id}`).toBeDefined();
      const output = await runner?.(harness);
      if (workflow.id === "layout-structural-visual") structuralVisual = output;
      const result = {
        id: workflow.id,
        category: workflow.category,
        callCount: harness.calls.length,
        usedRawExecute: harness.calls.includes("figma_execute"),
      };
      expect(result.callCount, workflow.id).toBeLessThanOrEqual(
        workflow.maxCalls,
      );
      expect(result.callCount, workflow.id).toBeLessThanOrEqual(
        benchmark.thresholds.maxCallsPerWorkflow,
      );
      results.push(result);
    }

    const autoLayout = results.filter(
      (result) => result.category === "auto-layout",
    );
    const typedRate =
      autoLayout.filter((result) => !result.usedRawExecute).length /
      autoLayout.length;
    expect(typedRate).toBeGreaterThanOrEqual(
      benchmark.thresholds.minAutoLayoutTypedRate,
    );
    expect(results.every((result) => result.callCount <= 5)).toBe(true);

    const expectedVisual = readJson<unknown>(
      "./snapshots/auto-layout-structural-visual.json",
    );
    expect(structuralVisual).toEqual(expectedVisual);
  });
});
