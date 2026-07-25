import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

interface MockNode {
  id: string;
  type: string;
  name: string;
  parent?: MockNode;
  children?: MockNode[];
  [key: string]: unknown;
}

function createHarness() {
  const messages: Record<string, unknown>[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};

  const root: MockNode = {
    id: "0:0",
    type: "DOCUMENT",
    name: "Plugin test",
    children: [],
  };
  const page: MockNode = {
    id: "1:0",
    type: "PAGE",
    name: "Page",
    parent: root,
    children: [],
    selection: [],
  };
  const frame: MockNode = {
    id: "2:0",
    type: "FRAME",
    name: "Parent",
    parent: page,
    children: [],
    width: 400,
    height: 300,
    visible: true,
    locked: false,
    layoutMode: "NONE",
    itemSpacing: 0,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    primaryAxisAlignItems: "MIN",
    counterAxisAlignItems: "MIN",
    layoutWrap: "NO_WRAP",
    primaryAxisSizingMode: "FIXED",
    counterAxisSizingMode: "FIXED",
    constraints: { horizontal: "LEFT", vertical: "TOP" },
  };
  const child: MockNode = {
    id: "2:1",
    type: "RECTANGLE",
    name: "Child",
    parent: frame,
    width: 100,
    height: 40,
    x: 0,
    y: 0,
    visible: true,
    locked: false,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    layoutPositioning: "AUTO",
    layoutAlign: "INHERIT",
    constraints: { horizontal: "LEFT", vertical: "TOP" },
  };
  const component: MockNode = {
    id: "3:0",
    type: "COMPONENT",
    name: "Button",
    parent: page,
    children: [],
    width: 120,
    height: 48,
    visible: true,
    locked: false,
    key: "component-key",
    description: "Button component",
    componentPropertyDefinitions: {},
  };
  const instance: MockNode = {
    id: "3:1",
    type: "INSTANCE",
    name: "Button instance",
    parent: page,
    children: [],
    width: 120,
    height: 48,
    visible: true,
    locked: false,
    componentProperties: { Label: { value: "Before" } },
    boundVariables: {},
    async getMainComponentAsync() {
      return component;
    },
    setProperties(properties: Record<string, string | boolean>) {
      this.componentProperties = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, { value }]),
      );
    },
    resetOverrides() {},
  };

  root.children = [page];
  page.children = [frame, component, instance];
  frame.children = [child];

  const nodes = new Map(
    [root, page, frame, child, component, instance].map((node) => [
      node.id,
      node,
    ]),
  );
  root.findAllWithCriteria = ({ types }: { types: string[] }) =>
    [...nodes.values()].filter((node) => types.includes(node.type));

  const figma = {
    fileKey: "test-file",
    root,
    currentPage: page,
    mixed: Symbol("mixed"),
    ui: {
      onmessage: undefined as
        | ((message: Record<string, unknown>) => Promise<void>)
        | undefined,
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    },
    variables: {
      async getLocalVariableCollectionsAsync() {
        return [];
      },
      async getLocalVariablesAsync() {
        return [];
      },
    },
    showUI() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers[event] = handler;
    },
    async loadAllPagesAsync() {},
    async getNodeByIdAsync(id: string) {
      return nodes.get(id) ?? null;
    },
  };

  const source = readFileSync(
    new URL("../plugin/main.js", import.meta.url),
    "utf8",
  );
  runInNewContext(source, {
    __html__: "",
    figma,
    structuredClone,
    setTimeout,
    clearTimeout,
    console,
  });

  async function command(method: string, params: Record<string, unknown>) {
    const requestId = `request-${messages.length + 1}`;
    await figma.ui.onmessage?.({
      type: "bridge-command",
      command: {
        requestId,
        fileKey: "test-file",
        method,
        params,
      },
    });
    return [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "bridge-result" && message.requestId === requestId,
      );
  }

  return { command, frame, child };
}

describe("Figma Plugin main bridge", () => {
  it("returns a predicted core node dry-run without mutating Figma", async () => {
    const { command, child } = createHarness();
    const preview = await command("node.update", {
      nodeIds: ["2:1"],
      patch: { name: "Preview name", x: 24 },
      dryRun: true,
    });

    expect(preview).toMatchObject({
      ok: true,
      data: [{ id: "2:1", name: "Preview name", x: 24 }],
    });
    expect(child.name).toBe("Child");
    expect(child.x).toBe(0);
  });

  it("returns structured-cloneable Component and Instance payloads", async () => {
    const { command } = createHarness();

    const inspected = await command("component", {
      action: "inspect",
      componentId: "3:0",
    });
    expect(inspected).toMatchObject({ ok: true });
    expect(() => structuredClone(inspected?.data)).not.toThrow();
    expect(inspected?.data).toMatchObject({
      component: { nodeId: "3:0", key: "component-key" },
      node: { id: "3:0", name: "Button" },
    });

    const updated = await command("instance", {
      action: "update",
      instanceIds: ["3:1"],
      properties: { Label: "After" },
    });
    expect(updated).toMatchObject({ ok: true });
    expect(() => structuredClone(updated?.data)).not.toThrow();
    expect(updated?.data).toMatchObject({
      instances: [{ id: "3:1", instanceProperties: { Label: "After" } }],
    });
  });

  it("previews dependency-ordered layout batches and rolls back failed writes", async () => {
    const { command, frame, child } = createHarness();
    const params = {
      action: "batch",
      operations: [
        {
          op: "sizing",
          nodeIds: ["2:1"],
          sizing: { horizontal: "FILL", vertical: "FIXED" },
        },
        {
          op: "apply",
          nodeIds: ["2:0"],
          layout: { layoutMode: "HORIZONTAL", gap: 12 },
        },
      ],
      dryRun: true,
    };

    const preview = await command("layout", params);
    expect(preview).toMatchObject({ ok: true });
    expect(preview?.data).toMatchObject({
      appliedOrder: ["apply:2:0", "sizing:2:1"],
      dryRun: true,
      after: [
        { nodeId: "2:0", layout: { layoutMode: "HORIZONTAL", gap: 12 } },
        { nodeId: "2:1", sizing: { horizontal: "FILL" } },
      ],
    });
    expect(frame.layoutMode).toBe("NONE");
    expect(child.layoutSizingHorizontal).toBe("FIXED");

    let value = "FIXED";
    let throwOnce = true;
    Object.defineProperty(child, "layoutSizingHorizontal", {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("simulated Figma write failure");
        }
        value = String(next);
      },
    });
    const applied = await command("layout", { ...params, dryRun: false });
    expect(applied).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(frame.layoutMode).toBe("NONE");
    expect(child.layoutSizingHorizontal).toBe("FIXED");
  });
});
