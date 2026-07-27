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
  const clientStorage = new Map<string, unknown>();
  const loadedFonts: unknown[] = [];
  let allPagesLoaded = false;

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
  const text: MockNode = {
    id: "2:2",
    type: "TEXT",
    name: "Label",
    parent: frame,
    width: 160,
    height: 24,
    x: 0,
    y: 56,
    visible: true,
    locked: false,
    characters: "Before",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PERCENT", value: 0 },
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    fills: [],
    strokes: [],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    layoutPositioning: "AUTO",
    layoutAlign: "INHERIT",
    constraints: { horizontal: "LEFT", vertical: "TOP" },
    getRangeAllFontNames() {
      return [this.fontName];
    },
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
  frame.children = [child, text];

  const nodes = new Map(
    [root, page, frame, child, text, component, instance].map((node) => [
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
    async loadFontAsync(font: unknown) {
      loadedFonts.push(font);
    },
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
    clientStorage: {
      async getAsync(key: string) {
        return clientStorage.get(key);
      },
      async setAsync(key: string, value: unknown) {
        clientStorage.set(key, structuredClone(value));
      },
      async deleteAsync(key: string) {
        clientStorage.delete(key);
      },
    },
    showUI() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "documentchange" && !allPagesLoaded) {
        throw new Error(
          "Cannot register documentchange before loadAllPagesAsync.",
        );
      }
      handlers[event] = handler;
    },
    async loadAllPagesAsync() {
      allPagesLoaded = true;
    },
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
    setTimeout,
    clearTimeout,
    console,
  });

  async function command(
    method: string,
    params: Record<string, unknown>,
    controls: Record<string, unknown> = {},
  ) {
    const requestId = `request-${messages.length + 1}`;
    await figma.ui.onmessage?.({
      type: "bridge-command",
      command: {
        requestId,
        fileKey: "test-file",
        method,
        params,
        ...controls,
      },
    });
    return [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "bridge-result" && message.requestId === requestId,
      );
  }

  return {
    command,
    frame,
    child,
    text,
    handlers,
    messages,
    clientStorage,
    loadedFonts,
    figma,
  };
}

describe("Figma Plugin main bridge", () => {
  it("gets, validates, stores, and clears the owner bridge config", async () => {
    const { figma, messages, clientStorage } = createHarness();
    const config = {
      version: 1,
      protocol: "mcp-fig-plugin/v1",
      port: 3847,
      credential: "a".repeat(43),
    };

    await figma.ui.onmessage?.({
      type: "bridge-config-get",
      requestId: "config-get-empty",
    });
    expect(messages.at(-1)).toEqual({
      type: "bridge-config-result",
      requestId: "config-get-empty",
      operation: "get",
      ok: true,
      config: null,
    });

    await figma.ui.onmessage?.({
      type: "bridge-config-set",
      requestId: "config-set",
      config,
    });
    expect(messages.at(-1)).toEqual({
      type: "bridge-config-result",
      requestId: "config-set",
      operation: "set",
      ok: true,
    });
    expect([...clientStorage.values()]).toEqual([config]);

    await figma.ui.onmessage?.({
      type: "bridge-config-get",
      requestId: "config-get-saved",
    });
    expect(messages.at(-1)).toEqual({
      type: "bridge-config-result",
      requestId: "config-get-saved",
      operation: "get",
      ok: true,
      config,
    });

    await figma.ui.onmessage?.({
      type: "bridge-config-set",
      requestId: "config-set-invalid",
      config: { ...config, port: 0 },
    });
    expect(messages.at(-1)).toMatchObject({
      type: "bridge-config-result",
      requestId: "config-set-invalid",
      operation: "set",
      ok: false,
      error: { code: "INVALID_CONFIG" },
    });
    expect([...clientStorage.values()]).toEqual([config]);

    await figma.ui.onmessage?.({
      type: "bridge-config-clear",
      requestId: "config-clear",
    });
    expect(messages.at(-1)).toEqual({
      type: "bridge-config-result",
      requestId: "config-clear",
      operation: "clear",
      ok: true,
    });
    expect(clientStorage.size).toBe(0);
  });

  it("returns the command traceId from Plugin main", async () => {
    const { command } = createHarness();
    await expect(
      command("selection.get", {}, { traceId: "trace-plugin-main" }),
    ).resolves.toMatchObject({
      type: "bridge-result",
      traceId: "trace-plugin-main",
      ok: true,
    });
  });

  it("proactively sends file identity after installing the UI handler", () => {
    const { messages } = createHarness();

    expect(messages).toContainEqual({
      type: "bridge-bootstrap",
      file: {
        key: "test-file",
        name: "Plugin test",
        revision: "1",
      },
    });
  });

  it("loads all pages before registering documentchange", async () => {
    const { handlers } = createHarness();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handlers.selectionchange).toBeTypeOf("function");
    expect(handlers.documentchange).toBeTypeOf("function");
  });

  it("updates and serializes typed typography properties", async () => {
    const { command, text } = createHarness();

    const result = await command("node.update", {
      nodeIds: ["2:2"],
      patch: {
        fontName: { family: "Inter", style: "Bold" },
        fontSize: 18,
        lineHeight: { unit: "PIXELS", value: 24 },
        letterSpacing: { unit: "PERCENT", value: 2 },
        textAlignHorizontal: "CENTER",
        textAlignVertical: "CENTER",
      },
    });

    expect(text).toMatchObject({
      fontName: { family: "Inter", style: "Bold" },
      fontSize: 18,
      lineHeight: { unit: "PIXELS", value: 24 },
      letterSpacing: { unit: "PERCENT", value: 2 },
      textAlignHorizontal: "CENTER",
      textAlignVertical: "CENTER",
    });
    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          id: "2:2",
          fontName: { family: "Inter", style: "Bold" },
          fontSize: 18,
          lineHeight: { unit: "PIXELS", value: 24 },
          letterSpacing: { unit: "PERCENT", value: 2 },
          textAlignHorizontal: "CENTER",
          textAlignVertical: "CENTER",
        },
      ],
    });
  });

  it("rejects typography properties on non-text nodes", async () => {
    const { command } = createHarness();

    await expect(
      command("node.update", {
        nodeIds: ["2:1"],
        patch: { fontSize: 18 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("rejects plain text replacement on mixed-font nodes", async () => {
    const { command, figma, text } = createHarness();
    text.fontName = figma.mixed;
    text.getRangeAllFontNames = () => [
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Bold" },
    ];

    await expect(
      command("node.update", {
        nodeIds: ["2:2"],
        patch: { text: "After" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(text.characters).toBe("Before");
  });

  it("allows explicit font unification while replacing mixed-font text", async () => {
    const { command, figma, loadedFonts, text } = createHarness();
    text.fontName = figma.mixed;

    await expect(
      command("node.update", {
        nodeIds: ["2:2"],
        patch: {
          text: "After",
          fontName: { family: "Inter", style: "Bold" },
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(text).toMatchObject({
      characters: "After",
      fontName: { family: "Inter", style: "Bold" },
    });
    expect(loadedFonts).toEqual([{ family: "Inter", style: "Bold" }]);
  });

  it("loads each mixed font once before applying uniform typography", async () => {
    const { command, figma, loadedFonts, text } = createHarness();
    text.fontName = figma.mixed;
    text.getRangeAllFontNames = () => [
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Bold" },
      { family: "Inter", style: "Regular" },
    ];

    await expect(
      command("node.update", {
        nodeIds: ["2:2"],
        patch: { fontSize: 16 },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(text.fontSize).toBe(16);
    expect(loadedFonts).toEqual([
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Bold" },
    ]);
  });

  it("does not count the Plugin's own documentchange event twice", async () => {
    const { command, handlers } = createHarness();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = await command("node.update", {
      nodeIds: ["2:1"],
      patch: { name: "Internal change" },
    });
    expect(first).toMatchObject({ ok: true, revision: "2" });

    handlers.documentchange?.({
      documentChanges: [{ id: "2:1", origin: "LOCAL" }],
    });
    const second = await command(
      "node.update",
      { nodeIds: ["2:1"], patch: { name: "Second change" } },
      { expectedRevision: "2" },
    );
    expect(second).toMatchObject({ ok: true, revision: "3" });
  });

  it("matches consecutive same-node Plugin changes one event at a time", async () => {
    const { command, handlers } = createHarness();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await command("node.update", {
      nodeIds: ["2:1"],
      patch: { name: "First internal change" },
    });
    const second = await command(
      "node.update",
      { nodeIds: ["2:1"], patch: { name: "Second internal change" } },
      { expectedRevision: "2" },
    );
    expect(second).toMatchObject({ ok: true, revision: "3" });

    const event = {
      documentChanges: [{ id: "2:1", origin: "LOCAL" }],
    };
    handlers.documentchange?.(event);
    handlers.documentchange?.(event);
    const third = await command(
      "node.update",
      { nodeIds: ["2:1"], patch: { name: "Third internal change" } },
      { expectedRevision: "3" },
    );
    expect(third).toMatchObject({ ok: true, revision: "4" });
  });

  it("does not suppress an unrelated external document change", async () => {
    const { command, handlers } = createHarness();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = await command("node.update", {
      nodeIds: ["2:1"],
      patch: { name: "Internal change" },
    });
    expect(first).toMatchObject({ ok: true, revision: "2" });

    handlers.documentchange?.({
      documentChanges: [{ id: "2:2", origin: "LOCAL" }],
    });
    const stale = await command(
      "node.update",
      { nodeIds: ["2:1"], patch: { name: "Must not apply" } },
      { expectedRevision: "2" },
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
      revision: "3",
    });
  });

  it("rejects a stale revision in the Plugin immediately before mutation", async () => {
    const { command, child, handlers } = createHarness();
    await new Promise((resolve) => setTimeout(resolve, 0));
    handlers.documentchange?.();

    const result = await command(
      "node.update",
      { nodeIds: ["2:1"], patch: { name: "Must not apply" } },
      {
        expectedRevision: "1",
        targetNodeIds: ["2:1"],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REVISION_CONFLICT",
        retryable: true,
        details: {
          expectedRevision: "1",
          actualRevision: "2",
          targetNodeIds: ["2:1"],
        },
      },
      revision: "2",
    });
    expect(child.name).toBe("Child");
  });

  it("replays a successful nonce before checking its now-stale revision", async () => {
    const { command, child } = createHarness();
    const params = { nodeIds: ["2:1"], patch: { name: "Applied once" } };
    const first = await command("node.update", params, {
      expectedRevision: "1",
      idempotencyKey: "plugin-restart-retry",
    });
    expect(first).toMatchObject({ ok: true, revision: "2" });

    child.name = "External marker";
    const replay = await command(
      "node.update",
      { patch: { name: "Applied once" }, nodeIds: ["2:1"] },
      {
        expectedRevision: "1",
        idempotencyKey: "plugin-restart-retry",
      },
    );
    expect(replay).toMatchObject({ ok: true, data: first?.data });
    expect(child.name).toBe("External marker");

    const conflict = await command(
      "node.update",
      { nodeIds: ["2:1"], patch: { name: "Different payload" } },
      {
        expectedRevision: "1",
        idempotencyKey: "plugin-restart-retry",
      },
    );
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(child.name).toBe("External marker");
  });

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
