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
  const exportSettings: unknown[] = [];
  let exportBytes: Uint8Array = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
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
    async exportAsync(settings: unknown) {
      exportSettings.push(settings);
      return exportBytes;
    },
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
    fills: [],
    strokes: [],
    opacity: 1,
    cornerRadius: 0,
    topLeftRadius: 0,
    topRightRadius: 0,
    bottomRightRadius: 0,
    bottomLeftRadius: 0,
    effects: [],
    blendMode: "PASS_THROUGH",
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
    base64Encode(data: Uint8Array) {
      return Buffer.from(data).toString("base64");
    },
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
    exportSettings,
    setExportBytes(value: Uint8Array) {
      exportBytes = value;
    },
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

  it("queries nodes in deterministic bounded preorder", async () => {
    const { command } = createHarness();

    await expect(
      command("node.query", {
        rootId: "1:0",
        name: "Child",
        nodeType: "RECTANGLE",
        path: ["Parent", "Child"],
        maxDepth: 3,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: ["Parent", "Child"],
            node: { id: "2:1", type: "RECTANGLE", name: "Child" },
          },
        ],
        limit: 10,
        truncated: false,
      },
    });

    await expect(
      command("node.query", {
        rootId: "1:0",
        nodeType: "RECTANGLE",
        maxDepth: 0,
        limit: 10,
      }),
    ).resolves.toMatchObject({ ok: true, data: { matches: [] } });
  });

  it("round-trips visual properties and serializes mixed values explicitly", async () => {
    const { command, child, figma } = createHarness();
    const patch = {
      fills: [
        { type: "SOLID", color: { r: 0.2, g: 0.3, b: 0.4 }, opacity: 0.8 },
      ],
      strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.6 }],
      opacity: 0.7,
      cornerRadius: 14,
      effects: [{ type: "LAYER_BLUR", radius: 6, visible: true }],
      blendMode: "MULTIPLY",
      constraints: { horizontal: "CENTER", vertical: "BOTTOM" },
    };

    await expect(
      command("node.update", { nodeIds: ["2:1"], patch }),
    ).resolves.toMatchObject({
      ok: true,
      data: [{ id: "2:1", ...patch }],
    });
    expect(child).toMatchObject({
      ...patch,
      constraints: { horizontal: "CENTER", vertical: "MAX" },
    });

    child.cornerRadius = figma.mixed;
    child.topLeftRadius = 1;
    child.topRightRadius = 2;
    child.bottomRightRadius = 3;
    child.bottomLeftRadius = 4;
    await expect(
      command("node.get", { nodeIds: ["2:1"] }),
    ).resolves.toMatchObject({
      ok: true,
      data: [
        {
          cornerRadius: { mixed: true },
          cornerRadii: {
            topLeft: 1,
            topRight: 2,
            bottomRight: 3,
            bottomLeft: 4,
          },
        },
      ],
    });
  });

  it("validates the whole visual-property batch before mutating any node", async () => {
    const { command, child } = createHarness();

    await expect(
      command("node.update", {
        nodeIds: ["2:1", "2:2"],
        patch: { cornerRadius: 9 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(child.cornerRadius).toBe(0);
  });

  it("rolls back the visual batch when a Figma setter fails mid-apply", async () => {
    const { command, child, text } = createHarness();
    let textOpacity = 1;
    Object.defineProperty(text, "opacity", {
      configurable: true,
      get: () => textOpacity,
      set: (value: number) => {
        if (value === 0.4) throw new Error("Figma setter rejected opacity");
        textOpacity = value;
      },
    });

    await expect(
      command("node.update", {
        nodeIds: ["2:1", "2:2"],
        patch: { opacity: 0.4 },
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(child.opacity).toBe(1);
    expect(textOpacity).toBe(1);
  });

  it("exports a node with typed image settings and base64 data", async () => {
    const { command, exportSettings } = createHarness();

    await expect(
      command("node.export", {
        nodeIds: ["2:0"],
        format: "PNG",
        scale: 2,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: [
        {
          nodeId: "2:0",
          nodeName: "Parent",
          format: "PNG",
          mimeType: "image/png",
          byteLength: 8,
          dataBase64: "iVBORw0KGgo=",
        },
      ],
    });
    expect(exportSettings).toEqual([
      { format: "PNG", constraint: { type: "SCALE", value: 2 } },
    ]);
  });

  it.each([
    [
      "JPG",
      2,
      "image/jpeg",
      { format: "JPG", constraint: { type: "SCALE", value: 2 } },
    ],
    ["SVG", undefined, "image/svg+xml", { format: "SVG" }],
    ["PDF", undefined, "application/pdf", { format: "PDF" }],
  ] as const)(
    "maps %s export settings and MIME type",
    async (format, scale, mimeType, settings) => {
      const { command, exportSettings } = createHarness();

      await expect(
        command("node.export", {
          nodeIds: ["2:0"],
          format,
          ...(scale === undefined ? {} : { scale }),
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: [{ format, mimeType }],
      });
      expect(exportSettings).toEqual([settings]);
    },
  );

  it("rejects non-exportable nodes and oversized exports", async () => {
    const { command, setExportBytes } = createHarness();

    await expect(
      command("node.export", {
        nodeIds: ["0:0"],
        format: "PNG",
        scale: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_BY_BRIDGE" },
    });

    setExportBytes(new Uint8Array(650_000));
    await expect(
      command("node.export", {
        nodeIds: ["2:0"],
        format: "PNG",
        scale: 1,
      }),
    ).resolves.toMatchObject({ ok: true });

    setExportBytes(new Uint8Array(650_001));
    await expect(
      command("node.export", {
        nodeIds: ["2:0"],
        format: "PNG",
        scale: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("lower the scale"),
      },
    });

    await expect(
      command("node.export", {
        nodeIds: ["2:0"],
        format: "SVG",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("source complexity"),
      },
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
