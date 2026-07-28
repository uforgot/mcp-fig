import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

interface MockNode {
  id: string;
  type: string;
  name: string;
  parent?: MockNode;
  children?: MockNode[];
  [key: string]: unknown;
}

interface MockVariableCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: Array<{ modeId: string; name: string }>;
  addMode(name: string): string;
  renameMode(modeId: string, name: string): void;
  removeMode(modeId: string): void;
  remove(): void;
}

interface MockVariable {
  id: string;
  key: string;
  name: string;
  description: string;
  resolvedType: string;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
  setValueForMode(modeId: string, value: unknown): void;
  remove(): void;
}

interface MockStyle {
  id: string;
  key: string;
  type: "PAINT" | "TEXT" | "EFFECT" | "GRID";
  name: string;
  description: string;
  remote: boolean;
  paints?: unknown[];
  effects?: unknown[];
  layoutGrids?: unknown[];
  fontName?: { family: string; style: string };
  fontSize?: number;
  lineHeight?: unknown;
  letterSpacing?: unknown;
  paragraphIndent?: number;
  paragraphSpacing?: number;
  textCase?: string;
  textDecoration?: string;
  remove(): void;
}

interface MockPluginResult {
  ok: boolean;
  data: Record<string, unknown>;
  error?: Record<string, unknown>;
}

function createHarness(
  options: {
    fileKey?: string | null;
    rootName?: string;
    rootPluginData?: Map<string, string>;
  } = {},
) {
  const messages: Record<string, unknown>[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const clientStorage = new Map<string, unknown>();
  const loadedFonts: unknown[] = [];
  const exportSettings: unknown[] = [];
  let exportBytes: Uint8Array = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  let allPagesLoaded = false;
  const rootPluginData = options.rootPluginData ?? new Map<string, string>();

  const root: MockNode = {
    id: "0:0",
    type: "DOCUMENT",
    name: options.rootName ?? "Plugin test",
    children: [],
    getPluginData(key: string) {
      return rootPluginData.get(key) ?? "";
    },
    setPluginData(key: string, value: string) {
      rootPluginData.set(key, value);
    },
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
  const rangeStyles = Array.from({ length: "Before".length }, () => ({
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PERCENT", value: 0 },
    fills: [],
  }));
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
    getRangeAllFontNames(start = 0, end = "Before".length) {
      return rangeStyles.slice(start, end).map((style) => style.fontName);
    },
    getStyledTextSegments(_fields: string[], start = 0, end = "Before".length) {
      const segments: Array<
        Record<string, unknown> & {
          start: number;
          end: number;
          characters: string;
          style: unknown;
        }
      > = [];
      for (let index = start; index < end; index += 1) {
        const style = structuredClone(rangeStyles[index]);
        const previous = segments.at(-1);
        if (
          previous &&
          JSON.stringify(previous.style) === JSON.stringify(style)
        ) {
          previous.end = index + 1;
          previous.characters = "Before".slice(previous.start, index + 1);
        } else {
          segments.push({
            start: index,
            end: index + 1,
            characters: "Before"[index] ?? "",
            ...style,
            style,
          });
        }
      }
      return segments.map(({ style: _style, ...segment }) => segment);
    },
    setRangeFontName(start: number, end: number, value: unknown) {
      rangeStyles.slice(start, end).forEach((style) => {
        style.fontName = structuredClone(value) as never;
      });
    },
    setRangeFontSize(start: number, end: number, value: number) {
      rangeStyles.slice(start, end).forEach((style) => {
        style.fontSize = value;
      });
    },
    setRangeLineHeight(start: number, end: number, value: unknown) {
      rangeStyles.slice(start, end).forEach((style) => {
        style.lineHeight = structuredClone(value) as never;
      });
    },
    setRangeLetterSpacing(start: number, end: number, value: unknown) {
      rangeStyles.slice(start, end).forEach((style) => {
        style.letterSpacing = structuredClone(value) as never;
      });
    },
    setRangeFills(start: number, end: number, value: unknown[]) {
      rangeStyles.slice(start, end).forEach((style) => {
        style.fills = structuredClone(value) as never[];
      });
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
    remote: false,
    key: "component-key",
    description: "Button component",
    componentPropertyDefinitions: {
      Label: { type: "TEXT", defaultValue: "Default" },
    },
  };
  const slot: MockNode = {
    id: "3:2",
    type: "SLOT",
    name: "Content",
    children: [],
    width: 120,
    height: 24,
    visible: true,
    locked: false,
    limitViolations: [],
    componentPropertyReferences: { slot: "Content" },
    resetSlot() {
      this.children = [];
    },
  };
  const instance: MockNode = {
    id: "3:1",
    type: "INSTANCE",
    name: "Button instance",
    parent: page,
    children: [slot],
    width: 120,
    height: 48,
    visible: true,
    locked: false,
    componentProperties: { "Label#3:0": { value: "Before" } },
    boundVariables: {},
    mainComponentRef: component,
    async getMainComponentAsync() {
      return this.mainComponentRef;
    },
    swapComponent(next: MockNode) {
      this.mainComponentRef = next;
    },
    setProperties(properties: Record<string, string | boolean>) {
      this.componentProperties = {
        ...(this.componentProperties as Record<
          string,
          { value: string | boolean }
        >),
        ...Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [key, { value }]),
        ),
      };
    },
    removeOverrides() {},
    resetOverrides() {},
  };
  slot.parent = instance;

  root.children = [page];
  page.children = [frame, component, instance];
  frame.children = [child, text];

  const nodes = new Map(
    [root, page, frame, child, text, component, instance, slot].map((node) => [
      node.id,
      node,
    ]),
  );
  let nextDynamicId = 10;
  function removeNode(node: MockNode) {
    const parent = node.parent;
    if (parent?.children)
      parent.children = parent.children.filter((item) => item !== node);
    delete node.parent;
    nodes.delete(node.id);
  }
  function installNode(node: MockNode) {
    node.remove = () => removeNode(node);
    node.setBoundVariable = (field: string, variable: MockVariable | null) => {
      if (!node.boundVariables) node.boundVariables = {};
      const bindings = node.boundVariables as Record<string, unknown>;
      if (variable)
        bindings[field] = { type: "VARIABLE_ALIAS", id: variable.id };
      else delete bindings[field];
    };
    if (node.children) {
      node.appendChild = (childNode: MockNode) => {
        if (childNode.parent?.children)
          childNode.parent.children = childNode.parent.children.filter(
            (item) => item !== childNode,
          );
        childNode.parent = node;
        node.children?.push(childNode);
        nodes.set(childNode.id, childNode);
      };
    }
    return node;
  }
  for (const node of nodes.values()) installNode(node);
  function installComponent(node: MockNode) {
    installNode(node);
    node.addComponentProperty = (
      name: string,
      type: string,
      defaultValue: string | boolean,
      options: Record<string, unknown> = {},
    ) => {
      const definitions = node.componentPropertyDefinitions as Record<
        string,
        Record<string, unknown>
      >;
      definitions[name] = { type, defaultValue, ...options };
      return name;
    };
    node.editComponentProperty = (
      name: string,
      propertyPatch: Record<string, unknown>,
    ) => {
      const definitions = node.componentPropertyDefinitions as Record<
        string,
        Record<string, unknown>
      >;
      const nextName =
        typeof propertyPatch.name === "string"
          ? `${propertyPatch.name}#${name.split("#").slice(1).join("#")}`
          : name;
      const { name: _name, ...definitionPatch } = propertyPatch;
      definitions[nextName] = { ...definitions[name], ...definitionPatch };
      if (nextName !== name) {
        delete definitions[name];
        for (const childNode of node.children ?? []) {
          const references = childNode.componentPropertyReferences as
            | { slot?: string }
            | undefined;
          if (references?.slot === name) references.slot = nextName;
        }
      }
      return nextName;
    };
    node.deleteComponentProperty = (name: string) => {
      const definitions = node.componentPropertyDefinitions as Record<
        string,
        Record<string, unknown>
      >;
      delete definitions[name];
    };
    node.createSlot = () => {
      const slotId = `dynamic:${nextDynamicId++}`;
      const propertyKey = `Slot#${slotId}`;
      const definitions = node.componentPropertyDefinitions as Record<
        string,
        Record<string, unknown>
      >;
      definitions[propertyKey] = { type: "SLOT", defaultValue: "" };
      const created = installNode({
        id: slotId,
        type: "SLOT",
        name: "Slot",
        parent: node,
        children: [],
        width: node.width,
        height: 24,
        visible: true,
        locked: false,
        limitViolations: [],
        componentPropertyReferences: { slot: propertyKey },
        resetSlot() {
          this.children = [];
        },
      });
      let currentSlotName = "Slot";
      Object.defineProperty(created, "name", {
        configurable: true,
        get: () => currentSlotName,
        set: (nextName: string) => {
          const references = created.componentPropertyReferences as {
            slot: string;
          };
          const previousKey = references.slot;
          const nextKey = `${nextName}#${previousKey.split("#").slice(1).join("#")}`;
          const previousDefinition = definitions[previousKey];
          if (!previousDefinition)
            throw new Error(`Missing slot property ${previousKey}.`);
          definitions[nextKey] = previousDefinition;
          delete definitions[previousKey];
          references.slot = nextKey;
          currentSlotName = nextName;
        },
      });
      node.children ??= [];
      node.children.push(created);
      nodes.set(created.id, created);
      return created;
    };
    node.createInstance = () => {
      const clonedSlots = (node.children ?? [])
        .filter((childNode) => childNode.type === "SLOT")
        .map((childNode) => {
          const cloned = installNode({
            id: `dynamic:${nextDynamicId++}`,
            type: "SLOT",
            name: childNode.name,
            children: [],
            width: childNode.width,
            height: childNode.height,
            visible: true,
            locked: false,
            limitViolations: [],
            componentPropertyReferences: structuredClone(
              childNode.componentPropertyReferences,
            ),
            resetSlot() {
              this.children = [];
            },
          });
          nodes.set(cloned.id, cloned);
          return cloned;
        });
      const created = installNode({
        id: `dynamic:${nextDynamicId++}`,
        type: "INSTANCE",
        name: node.name,
        children: clonedSlots,
        width: node.width,
        height: node.height,
        componentProperties: Object.fromEntries(
          Object.entries(
            node.componentPropertyDefinitions as Record<
              string,
              { type: string; defaultValue: string | boolean }
            >,
          ).map(([key, value]) => [
            key,
            { type: value.type, value: value.defaultValue },
          ]),
        ),
        mainComponentRef: node,
        async getMainComponentAsync() {
          return this.mainComponentRef;
        },
        setProperties(properties: Record<string, string | boolean>) {
          this.componentProperties = {
            ...(this.componentProperties as Record<string, unknown>),
            ...Object.fromEntries(
              Object.entries(properties).map(([key, value]) => [
                key,
                {
                  ...(
                    this.componentProperties as Record<
                      string,
                      Record<string, unknown>
                    >
                  )[key],
                  value,
                },
              ]),
            ),
          };
        },
        removeOverrides() {},
        resetOverrides() {},
        swapComponent(next: MockNode) {
          this.mainComponentRef = next;
        },
      });
      for (const clonedSlot of clonedSlots) clonedSlot.parent = created;
      (page.appendChild as ((childNode: MockNode) => void) | undefined)?.(
        created,
      );
      nodes.set(created.id, created);
      return created;
    };
    return node;
  }
  installComponent(component);
  const remoteComponent = installComponent({
    id: "library:card",
    type: "COMPONENT",
    name: "Card",
    children: [],
    width: 160,
    height: 80,
    visible: true,
    locked: false,
    remote: true,
    key: "library-card-key",
    description: "Library card",
    componentPropertyDefinitions: {
      "Label#library:card": { type: "TEXT", defaultValue: "Default" },
    },
  });
  root.findAllWithCriteria = ({ types }: { types: string[] }) =>
    [...nodes.values()].filter((node) => types.includes(node.type));

  const images = new Map<
    string,
    {
      hash: string;
      bytes: Uint8Array;
      width: number;
      height: number;
      getBytesAsync(): Promise<Uint8Array>;
      getSizeAsync(): Promise<{ width: number; height: number }>;
    }
  >();
  const variableCollections = new Map<string, MockVariableCollection>();
  const localVariables = new Map<string, MockVariable>();
  let nextCollectionId = 1;
  let nextVariableId = 1;
  let nextModeId = 1;
  function createVariableCollection(name: string) {
    const id = `VariableCollectionId:test:${nextCollectionId++}`;
    const defaultModeId = `mode:test:${nextModeId++}`;
    const collection: MockVariableCollection = {
      id,
      name,
      defaultModeId,
      modes: [{ modeId: defaultModeId, name: "Mode 1" }],
      addMode(modeName: string) {
        const modeId = `mode:test:${nextModeId++}`;
        this.modes.push({ modeId, name: modeName });
        return modeId;
      },
      renameMode(modeId: string, modeName: string) {
        const mode = this.modes.find(
          (candidate: { modeId: string }) => candidate.modeId === modeId,
        );
        if (!mode) throw new Error("mode missing");
        mode.name = modeName;
      },
      removeMode(modeId: string) {
        if (modeId === this.defaultModeId || this.modes.length === 1)
          throw new Error("cannot remove default mode");
        this.modes = this.modes.filter(
          (candidate: { modeId: string }) => candidate.modeId !== modeId,
        );
        for (const variable of localVariables.values())
          delete variable.valuesByMode[modeId];
      },
      remove() {
        variableCollections.delete(id);
        for (const [variableId, variable] of localVariables)
          if (variable.variableCollectionId === id)
            localVariables.delete(variableId);
      },
    };
    variableCollections.set(id, collection);
    return collection;
  }
  function createVariable(
    name: string,
    collection: MockVariableCollection,
    resolvedType: string,
  ) {
    const id = `VariableID:test:${nextVariableId++}`;
    const variable: MockVariable = {
      id,
      key: `variable-key-${nextVariableId}`,
      name,
      description: "",
      resolvedType,
      variableCollectionId: collection.id,
      valuesByMode: {},
      setValueForMode(modeId: string, value: unknown) {
        this.valuesByMode[modeId] = structuredClone(value);
      },
      remove() {
        localVariables.delete(id);
      },
    };
    localVariables.set(id, variable);
    return variable;
  }

  const localStyles = new Map<string, MockStyle>();
  const viewportFocuses: string[][] = [];
  let nextStyleId = 1;
  function createStyle(type: MockStyle["type"]): MockStyle {
    const id = `S:test:${nextStyleId++}`;
    const style: MockStyle = {
      id,
      key: `style-key-${nextStyleId}`,
      type,
      name: "",
      description: "",
      remote: false,
      ...(type === "PAINT" ? { paints: [] } : {}),
      ...(type === "EFFECT" ? { effects: [] } : {}),
      ...(type === "GRID" ? { layoutGrids: [] } : {}),
      ...(type === "TEXT"
        ? {
            fontName: { family: "Inter", style: "Regular" },
            fontSize: 12,
            lineHeight: { unit: "AUTO" },
            letterSpacing: { unit: "PIXELS", value: 0 },
            paragraphIndent: 0,
            paragraphSpacing: 0,
            textCase: "ORIGINAL",
            textDecoration: "NONE",
          }
        : {}),
      remove() {
        localStyles.delete(id);
      },
    };
    localStyles.set(id, style);
    return style;
  }

  const figma = {
    fileKey: options.fileKey === undefined ? "test-file" : options.fileKey,
    root,
    currentPage: page,
    mixed: Symbol("mixed"),
    viewport: {
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      scrollAndZoomIntoView(focusNodes: MockNode[]) {
        viewportFocuses.push(focusNodes.map((node) => node.id));
      },
    },
    createComponent() {
      const created = installComponent({
        id: `dynamic:${nextDynamicId++}`,
        type: "COMPONENT",
        name: "Component",
        parent: page,
        children: [],
        width: 100,
        height: 40,
        visible: true,
        locked: false,
        remote: false,
        key: `component-key-${nextDynamicId}`,
        description: "",
        componentPropertyDefinitions: {},
      });
      (page.appendChild as ((childNode: MockNode) => void) | undefined)?.(
        created,
      );
      return created;
    },
    combineAsVariants(variants: MockNode[], parent: MockNode) {
      const definitions: Record<string, Record<string, unknown>> = {};
      for (const variant of variants) {
        for (const pair of variant.name.split(", ")) {
          const [name, value] = pair.split("=");
          if (!name || !value) continue;
          let definition = definitions[name];
          if (!definition) {
            definition = {
              type: "VARIANT",
              defaultValue: value,
              variantOptions: [],
            };
            definitions[name] = definition;
          }
          const options = definition.variantOptions as string[];
          if (!options.includes(value)) options.push(value);
        }
      }
      const set = installComponent({
        id: `dynamic:${nextDynamicId++}`,
        type: "COMPONENT_SET",
        name: "Component set",
        children: variants,
        width: 200,
        height: 100,
        visible: true,
        locked: false,
        remote: false,
        key: `set-key-${nextDynamicId}`,
        description: "",
        componentPropertyDefinitions: definitions,
      });
      for (const variant of variants) {
        variant.parent = set;
        Object.defineProperty(variant, "componentPropertyDefinitions", {
          configurable: true,
          get() {
            throw new Error(
              "Can only get component property definitions of a component set or non-variant component",
            );
          },
        });
      }
      parent.children = (parent.children ?? []).filter(
        (childNode) => !variants.includes(childNode),
      );
      (parent.appendChild as (node: MockNode) => void)(set);
      nodes.set(set.id, set);
      return set;
    },
    async importComponentByKeyAsync(key: string) {
      if (key === "pending-key") return await new Promise(() => {});
      if (key !== "library-card-key") throw new Error("library denied");
      nodes.set(remoteComponent.id, remoteComponent);
      return remoteComponent;
    },
    async importComponentSetByKeyAsync(_key: string) {
      throw new Error("component set unavailable");
    },
    base64Encode(data: Uint8Array) {
      return Buffer.from(data).toString("base64");
    },
    base64Decode(data: string) {
      return Uint8Array.from(Buffer.from(data, "base64"));
    },
    createImage(data: Uint8Array) {
      if (data.byteLength < 6) throw new Error("invalid image");
      const hash = `image-${images.size + 1}`;
      const bytes = Uint8Array.from(data);
      const image = {
        hash,
        bytes,
        width: 1,
        height: 1,
        async getBytesAsync() {
          return Uint8Array.from(bytes);
        },
        async getSizeAsync() {
          return { width: 1, height: 1 };
        },
      };
      images.set(hash, image);
      return image;
    },
    getImageByHash(hash: string) {
      return images.get(hash) ?? null;
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
    async getLocalPaintStylesAsync() {
      return [...localStyles.values()].filter(
        (style) => style.type === "PAINT",
      );
    },
    async getLocalTextStylesAsync() {
      return [...localStyles.values()].filter((style) => style.type === "TEXT");
    },
    async getLocalEffectStylesAsync() {
      return [...localStyles.values()].filter(
        (style) => style.type === "EFFECT",
      );
    },
    async getLocalGridStylesAsync() {
      return [...localStyles.values()].filter((style) => style.type === "GRID");
    },
    createPaintStyle() {
      return createStyle("PAINT");
    },
    createTextStyle() {
      return createStyle("TEXT");
    },
    createEffectStyle() {
      return createStyle("EFFECT");
    },
    createGridStyle() {
      return createStyle("GRID");
    },
    async importStyleByKeyAsync() {
      throw new Error("style import denied");
    },
    variables: {
      async getLocalVariableCollectionsAsync() {
        return [...variableCollections.values()];
      },
      async getLocalVariablesAsync() {
        return [...localVariables.values()];
      },
      async getVariableCollectionByIdAsync(id: string) {
        return variableCollections.get(id) ?? null;
      },
      async getVariableByIdAsync(id: string) {
        return localVariables.get(id) ?? null;
      },
      createVariableCollection,
      createVariable,
      async importVariableByKeyAsync() {
        throw new Error("variable import denied");
      },
      createVariableAlias(variable: MockVariable) {
        if (!variable) throw new Error("alias target missing");
        return { type: "VARIABLE_ALIAS", id: variable.id };
      },
      setBoundVariableForPaint(
        paint: Record<string, unknown>,
        field: string,
        variable: MockVariable | null,
      ) {
        const next = structuredClone(paint);
        const boundVariables = {
          ...((next.boundVariables as Record<string, unknown> | undefined) ??
            {}),
        };
        if (variable)
          boundVariables[field] = {
            type: "VARIABLE_ALIAS",
            id: variable.id,
          };
        else delete boundVariables[field];
        if (Object.keys(boundVariables).length > 0)
          next.boundVariables = boundVariables;
        else delete next.boundVariables;
        return next;
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
    page,
    frame,
    child,
    text,
    component,
    instance,
    handlers,
    messages,
    clientStorage,
    loadedFonts,
    rangeStyles,
    exportSettings,
    viewportFocuses,
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

  it("persists a unique identity for each local Draft across Plugin restarts", () => {
    const persisted = new Map<string, string>();
    const first = createHarness({
      fileKey: null,
      rootName: "Draft",
      rootPluginData: persisted,
    });
    const restarted = createHarness({
      fileKey: null,
      rootName: "Draft",
      rootPluginData: persisted,
    });
    const duplicateNames = ["draft", " Draft ", "Ｄｒａｆｔ"];
    const duplicates = duplicateNames.map((rootName) => {
      const copiedPluginData = new Map(persisted);
      return {
        copiedPluginData,
        harness: createHarness({
          fileKey: null,
          rootName,
          rootPluginData: copiedPluginData,
        }),
      };
    });
    const other = createHarness({ fileKey: null, rootName: "Draft" });
    const bootstrapKey = (messages: Record<string, unknown>[]) => {
      const bootstrap = messages.find(
        (message) => message.type === "bridge-bootstrap",
      );
      if (!bootstrap) throw new Error("Missing bridge bootstrap message.");
      return (bootstrap.file as { key: string }).key;
    };

    const firstKey = bootstrapKey(first.messages);
    expect(firstKey).toMatch(/^local:[a-z0-9-]{16,80}:[0-9a-f]+$/);
    expect(bootstrapKey(restarted.messages)).toBe(firstKey);
    const duplicateKeys = duplicates.map(({ harness }) =>
      bootstrapKey(harness.messages),
    );
    expect(new Set([firstKey, ...duplicateKeys]).size).toBe(4);
    for (const { copiedPluginData } of duplicates) {
      expect(copiedPluginData).toEqual(persisted);
    }
    expect(bootstrapKey(other.messages)).not.toBe(firstKey);
    expect([...persisted.keys()]).toEqual(["mcp-fig.local-file-id.v1"]);
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

  it("round-trips visual properties and rejects whole-node mixed writes", async () => {
    const { command, child, figma, text } = createHarness();
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

    child.fills = figma.mixed;
    text.fills = [];
    await expect(
      command("node.update", {
        nodeIds: ["2:2", "2:1"],
        patch: {
          fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("mixed fills"),
      },
    });
    expect(text.fills).toEqual([]);
    expect(child.fills).toBe(figma.mixed);
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

  it("prepares viewport, selection, and node Desktop screenshot scopes under a lease", async () => {
    const { command, page, child, viewportFocuses } = createHarness();
    page.selection = [child];
    child.absoluteBoundingBox = { x: 10, y: 20, width: 100, height: 40 };

    const viewport = (await command("visual", {
      action: "prepare_capture",
      scope: "viewport",
      focus: true,
    })) as unknown as MockPluginResult;
    expect(viewport).toMatchObject({
      ok: true,
      data: {
        fileName: "Plugin test",
        pageId: "1:0",
        scope: "viewport",
        focusNodeIds: [],
        viewportBounds: { x: 0, y: 0, width: 1200, height: 800 },
      },
    });
    expect(viewport.data.leaseId).toMatch(/^capture-/);
    await expect(
      command("visual", {
        action: "prepare_capture",
        scope: "selection",
        focus: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "BUSY" } });
    await expect(
      command("visual", {
        action: "release_capture",
        leaseId: viewport.data.leaseId,
      }),
    ).resolves.toMatchObject({ ok: true, data: { released: true } });

    const selection = (await command("visual", {
      action: "prepare_capture",
      scope: "selection",
      focus: true,
    })) as unknown as MockPluginResult;
    expect(selection).toMatchObject({
      ok: true,
      data: {
        scope: "selection",
        focusNodeIds: ["2:1"],
        focusBounds: { x: 10, y: 20, width: 100, height: 40 },
      },
    });
    await command("visual", {
      action: "release_capture",
      leaseId: selection.data.leaseId,
    });

    const node = (await command("visual", {
      action: "prepare_capture",
      scope: "node",
      nodeIds: ["2:1"],
      focus: true,
    })) as unknown as MockPluginResult;
    expect(node).toMatchObject({ ok: true });
    await command("visual", {
      action: "release_capture",
      leaseId: node.data.leaseId,
    });
    expect(viewportFocuses).toEqual([["2:1"], ["2:1"]]);
  });

  it("audits clipped, overlapping, and low-contrast P0 fixtures within caps", async () => {
    const { command, frame, child, text } = createHarness();
    frame.clipsContent = true;
    frame.layoutMode = "HORIZONTAL";
    child.layoutPositioning = "ABSOLUTE";
    text.layoutPositioning = "AUTO";
    frame.absoluteBoundingBox = { x: 0, y: 0, width: 100, height: 100 };
    frame.absoluteRenderBounds = { x: 0, y: 0, width: 100, height: 100 };
    frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    child.absoluteBoundingBox = { x: 80, y: 10, width: 40, height: 40 };
    child.absoluteRenderBounds = { x: 80, y: 10, width: 20, height: 40 };
    child.fills = [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8 } }];
    text.absoluteBoundingBox = { x: 85, y: 15, width: 60, height: 20 };
    text.absoluteRenderBounds = { x: 85, y: 15, width: 60, height: 20 };
    text.fontSize = 10;
    text.fontWeight = 400;
    text.fills = [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8 } }];
    text.textStyleId = "";

    const result = (await command("visual", {
      action: "audit",
      rootNodeIds: ["2:0"],
      categories: ["accessibility", "design_system", "layout", "lint"],
      maxDepth: 2,
      maxNodes: 20,
      maxIssues: 20,
    })) as unknown as MockPluginResult;
    expect(result.ok).toBe(true);
    const issues = result.data.issues as Array<{ code: string }>;
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "CLIPPED_CONTENT",
        "OVERLAP",
        "TEXT_TOO_SMALL",
        "UNSTYLED_TEXT",
      ]),
    );
    expect(result.data).toMatchObject({
      inspectedNodes: 3,
      truncated: false,
      proof: { type: "model-state-audit", pixelAnalysis: false },
    });
    expect(issues.map((issue) => issue.code)).not.toContain(
      "LOW_TEXT_CONTRAST",
    );

    child.absoluteBoundingBox = { x: 10, y: 60, width: 20, height: 20 };
    child.absoluteRenderBounds = { x: 10, y: 60, width: 20, height: 20 };
    text.fontSize = 20;
    text.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }];
    const outsideParent = (await command("visual", {
      action: "audit",
      rootNodeIds: ["2:0"],
      categories: ["accessibility"],
      maxDepth: 2,
      maxNodes: 20,
      maxIssues: 20,
    })) as unknown as MockPluginResult;
    expect(
      (outsideParent.data.issues as Array<{ code: string }>).map(
        (issue) => issue.code,
      ),
    ).not.toContain("LOW_TEXT_CONTRAST");

    text.absoluteBoundingBox = { x: 30, y: 15, width: 60, height: 20 };
    text.absoluteRenderBounds = { x: 30, y: 15, width: 60, height: 20 };
    const threshold = (await command("visual", {
      action: "audit",
      rootNodeIds: ["2:0"],
      categories: ["accessibility"],
      maxDepth: 2,
      maxNodes: 20,
      maxIssues: 20,
    })) as unknown as MockPluginResult;
    expect(
      (threshold.data.issues as Array<{ code: string }>).map(
        (issue) => issue.code,
      ),
    ).toContain("LOW_TEXT_CONTRAST");

    text.opacity = 0.5;
    const alpha = (await command("visual", {
      action: "audit",
      rootNodeIds: ["2:0"],
      categories: ["accessibility"],
      maxDepth: 2,
      maxNodes: 20,
      maxIssues: 20,
    })) as unknown as MockPluginResult;
    expect(
      (alpha.data.issues as Array<{ code: string }>).map((issue) => issue.code),
    ).not.toContain("LOW_TEXT_CONTRAST");
    text.opacity = 1;

    const capped = (await command("visual", {
      action: "audit",
      rootNodeIds: ["2:0"],
      categories: ["accessibility", "design_system", "layout", "lint"],
      maxDepth: 2,
      maxNodes: 20,
      maxIssues: 2,
    })) as unknown as MockPluginResult;
    expect(capped.data.issues).toHaveLength(2);
    expect(capped.data.truncated).toBe(true);
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
      instances: [{ id: "3:1", instanceProperties: { "Label#3:0": "After" } }],
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

  it("styles bounded text ranges while preserving untouched mixed-font characters", async () => {
    const { command, figma, rangeStyles, text } = createHarness();
    const outsideRange = rangeStyles.at(4);
    if (!outsideRange) throw new Error("missing outside range fixture");
    outsideRange.fontName = { family: "Roboto", style: "Bold" };
    text.fontName = figma.mixed;

    await expect(
      command("node.text_range", {
        action: "update",
        nodeId: "2:2",
        ranges: [
          {
            start: 0,
            end: 3,
            style: {
              fontName: { family: "Inter", style: "Bold" },
              fontSize: 18,
              fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(text.characters).toBe("Before");
    const firstRange = rangeStyles.at(0);
    if (!firstRange) throw new Error("missing first range fixture");
    expect(firstRange).toMatchObject({
      fontName: { style: "Bold" },
      fontSize: 18,
    });
    expect(outsideRange.fontName).toEqual({
      family: "Roboto",
      style: "Bold",
    });

    await expect(
      command("node.text_range", {
        action: "read",
        nodeId: "2:2",
        start: 0,
        end: 5,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { nodeId: "2:2", start: 0, end: 5, characters: "Befor" },
    });
    await expect(
      command("node.text_range", {
        action: "read",
        nodeId: "2:2",
        start: 3,
        end: 99,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("rolls back range styles after a later setter fails", async () => {
    const { command, rangeStyles, text } = createHarness();
    const original = text.setRangeFills as (
      start: number,
      end: number,
      fills: unknown[],
    ) => void;
    let failOnce = true;
    text.setRangeFills = (start: number, end: number, fills: unknown[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated range fill failure");
      }
      original.call(text, start, end, fills);
    };
    await expect(
      command("node.text_range", {
        action: "update",
        nodeId: "2:2",
        ranges: [
          {
            start: 0,
            end: 3,
            style: {
              fontSize: 20,
              fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(rangeStyles.at(0)).toMatchObject({ fontSize: 12, fills: [] });
  });

  it("imports, inspects, appends, and replaces image fills", async () => {
    const { command, child } = createHarness();
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const imported = await command("node.image", {
      action: "import",
      mimeType: "image/png",
      dataBase64: Buffer.from(png).toString("base64"),
    });
    expect(imported).toMatchObject({
      ok: true,
      data: { hash: "image-1", mimeType: "image/png", width: 1, height: 1 },
    });
    await expect(
      command("node.image", { action: "inspect", hash: "image-1" }),
    ).resolves.toMatchObject({ ok: true, data: { byteLength: 9 } });
    await expect(
      command("node.image", {
        action: "fill",
        nodeIds: ["2:1"],
        hash: "image-1",
        operation: "append",
        scaleMode: "FIT",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(child.fills).toEqual([
      { type: "IMAGE", imageHash: "image-1", scaleMode: "FIT" },
    ]);
    await expect(
      command("node.image", {
        action: "fill",
        nodeIds: ["2:1"],
        hash: "image-1",
        operation: "replace",
        index: 0,
        scaleMode: "FILL",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(child.fills).toEqual([
      { type: "IMAGE", imageHash: "image-1", scaleMode: "FILL" },
    ]);
    await expect(
      command("node.image", {
        action: "import",
        mimeType: "image/png",
        dataBase64: Buffer.from("not-image").toString("base64"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("cleans up the current component when variant append fails", async () => {
    const { command, page, frame } = createHarness();
    const beforePage = page.children?.map((node) => node.id);
    frame.appendChild = () => {
      throw new Error("variant append failed");
    };
    await expect(
      command("component", {
        action: "create_set",
        parentId: "2:0",
        name: "Broken set",
        axes: { State: ["Default"] },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(page.children?.map((node) => node.id)).toEqual(beforePage);
  });

  it("creates and inspects a local component set with canonical variant properties", async () => {
    const { command } = createHarness();
    const created = await command("component", {
      action: "create_set",
      parentId: "1:0",
      name: "Control",
      axes: { State: ["Default", "Hover"], Size: ["S", "L"] },
    });
    expect(created).toMatchObject({
      ok: true,
      data: {
        componentSet: {
          type: "COMPONENT_SET",
          name: "Control",
          componentProperties: {
            State: { type: "VARIANT", options: ["Default", "Hover"] },
            Size: { type: "VARIANT", options: ["S", "L"] },
          },
        },
      },
    });
    const search = await command("component", {
      action: "search",
      query: "control",
    });
    expect(search).toMatchObject({
      ok: true,
      data: { components: [{ source: "local", name: "Control" }] },
    });
    if (!created?.data)
      throw new Error("Component set fixture returned no data.");
    const setId = (created.data as { componentSet: { id: string } })
      .componentSet.id;
    await expect(
      command("component", {
        action: "property_add",
        componentId: setId,
        propertyName: "Label",
        property: { type: "TEXT", defaultValue: "Continue" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        component: {
          properties: { Label: { type: "TEXT", defaultValue: "Continue" } },
        },
      },
    });
    await expect(
      command("component", {
        action: "slot_create",
        componentId: setId,
        slotName: "Content",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_BY_BRIDGE" },
    });
    await expect(
      command("component", {
        action: "property_add",
        componentId: setId,
        propertyName: "Manual variant",
        property: { type: "VARIANT", defaultValue: "A" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_BY_BRIDGE" },
    });
    await expect(
      command("component", {
        action: "property_update",
        componentId: setId,
        propertyName: "Label",
        patch: { type: "BOOLEAN" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("removes a newly created instance when property validation fails", async () => {
    const { command, page } = createHarness();
    const before = page.children?.map((node) => node.id);
    await expect(
      command("instance", {
        action: "create",
        parentId: "1:0",
        componentId: "3:0",
        properties: { Missing: "value" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(page.children?.map((node) => node.id)).toEqual(before);
  });

  it("cleans up a native slot when metadata editing fails", async () => {
    const { command, component } = createHarness();
    const definitions = component.componentPropertyDefinitions as Record<
      string,
      unknown
    >;
    const beforeKeys = Object.keys(definitions);
    const beforeChildren = component.children?.map((node) => node.id);
    component.editComponentProperty = () => {
      throw new Error("slot metadata failed");
    };
    await expect(
      command("component", {
        action: "slot_create",
        componentId: "3:0",
        slotName: "Footer",
        description: "will fail",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(Object.keys(definitions)).toEqual(beforeKeys);
    expect(component.children?.map((node) => node.id)).toEqual(beforeChildren);
  });

  it("creates a native slot and operates it through an instance", async () => {
    const { command } = createHarness();
    const createdSlot = await command("component", {
      action: "slot_create",
      componentId: "3:0",
      slotName: "Footer",
      allowedComponentKeys: ["library-card-key"],
      description: "Card footer",
      slotSettings: { minChildren: 0, maxChildren: 2 },
    });
    expect(createdSlot).toMatchObject({
      ok: true,
      data: {
        slot: { type: "SLOT", name: "Footer" },
        component: { properties: {} },
      },
    });
    const slotData = createdSlot?.data as
      | {
          propertyKey?: string;
          component?: { properties?: Record<string, unknown> };
        }
      | undefined;
    expect(slotData?.propertyKey).toMatch(/^Footer#/);
    expect(slotData?.component?.properties).toHaveProperty(
      String(slotData?.propertyKey),
      expect.objectContaining({
        type: "SLOT",
        options: ["library-card-key"],
        description: "Card footer",
        slotSettings: { minChildren: 0, maxChildren: 2 },
      }),
    );

    const createdInstance = await command("instance", {
      action: "create",
      parentId: "1:0",
      componentId: "3:0",
    });
    const instanceId = (
      createdInstance?.data as { instances?: Array<{ id: string }> } | undefined
    )?.instances?.[0]?.id;
    if (!instanceId) throw new Error("Native slot instance was not created.");
    await expect(
      command("instance", {
        action: "slot_append",
        instanceId,
        slotName: "Footer",
        componentKey: "library-card-key",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { slot: { type: "SLOT", name: "Footer", childCount: 1 } },
    });
    await expect(
      command("instance", {
        action: "slot_reset",
        instanceId,
        slotName: "Footer",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { slot: { type: "SLOT", name: "Footer", childCount: 0 } },
    });
  });

  it("reports destructive slot reset failures as unknown", async () => {
    const { command, page } = createHarness();
    await command("component", {
      action: "slot_create",
      componentId: "3:0",
      slotName: "Footer",
    });
    const createdInstance = await command("instance", {
      action: "create",
      parentId: "1:0",
      componentId: "3:0",
    });
    const instanceId = (
      createdInstance?.data as { instances?: Array<{ id: string }> } | undefined
    )?.instances?.[0]?.id;
    if (!instanceId) throw new Error("Slot reset instance was not created.");
    const createdNode = page.children?.find((node) => node.id === instanceId);
    const slot = createdNode?.children?.find((node) => node.type === "SLOT");
    if (!slot) throw new Error("Slot reset fixture was not materialized.");
    slot.resetSlot = () => {
      throw new Error("slot reset failed");
    };
    await expect(
      command("instance", {
        action: "slot_reset",
        instanceId,
        slotName: "Footer",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_OUTCOME",
        details: { instanceId, slotId: slot.id },
      },
    });
  });

  it("inspects, swaps, overrides, and resets instances", async () => {
    const { command } = createHarness();
    await expect(
      command("instance", {
        action: "swap",
        instanceIds: ["3:1"],
        componentKey: "library-card-key",
        preserveOverrides: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { instances: [{ mainComponentKey: "library-card-key" }] },
    });
    await command("instance", {
      action: "update",
      instanceIds: ["3:1"],
      properties: { Label: "After" },
    });
    await expect(
      command("instance", { action: "reset", instanceIds: ["3:1"] }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        instances: [{ instanceProperties: { "Label#3:0": "Default" } }],
      },
    });
  });

  it("reports swap and reset failures as unknown without destructive fake rollback", async () => {
    const swapHarness = createHarness();
    swapHarness.instance.swapComponent = () => {
      throw new Error("swap failed");
    };
    await expect(
      swapHarness.command("instance", {
        action: "swap",
        instanceIds: ["3:1"],
        componentKey: "library-card-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_OUTCOME",
        details: { completedCount: 0, attemptedIndex: 0, total: 1 },
      },
    });

    const resetHarness = createHarness();
    resetHarness.instance.removeOverrides = () => {
      resetHarness.instance.visualOverridesRemoved = true;
    };
    resetHarness.instance.setProperties = () => {
      throw new Error("reset property write failed");
    };
    await expect(
      resetHarness.command("instance", {
        action: "reset",
        instanceIds: ["3:1"],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_OUTCOME",
        details: { completedCount: 0, attemptedIndex: 0, total: 1 },
      },
    });
    expect(resetHarness.instance.visualOverridesRemoved).toBe(true);
  });

  it("reports an uncancellable library import timeout as unknown", async () => {
    vi.useFakeTimers();
    try {
      const { command } = createHarness();
      const pending = command("component", {
        action: "library_import",
        componentKey: "pending-key",
        kind: "COMPONENT",
      });
      await vi.advanceTimersByTimeAsync(4000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: {
          code: "UNKNOWN_OUTCOME",
          details: {
            reason: "TIMEOUT_PENDING",
            componentKey: "pending-key",
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("manages Plugin local styles and keeps library import distinct", async () => {
    const { command, loadedFonts } = createHarness();
    const writes = [
      {
        kind: "PAINT",
        name: "Surface/Brand",
        paints: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }],
      },
      {
        kind: "TEXT",
        name: "Type/Body",
        text: {
          fontName: { family: "Inter", style: "Regular" },
          fontSize: 16,
          lineHeight: { unit: "PIXELS", value: 24 },
          letterSpacing: { unit: "PERCENT", value: 0 },
        },
      },
      {
        kind: "EFFECT",
        name: "Elevation/Low",
        effects: [
          {
            type: "DROP_SHADOW",
            color: { r: 0, g: 0, b: 0, a: 0.2 },
            offset: { x: 0, y: 2 },
            radius: 8,
            visible: true,
            blendMode: "NORMAL",
          },
        ],
      },
      {
        kind: "GRID",
        name: "Grid/Desktop",
        grids: [
          {
            pattern: "COLUMNS",
            alignment: "STRETCH",
            gutterSize: 24,
            count: 12,
            offset: 0,
          },
        ],
      },
    ];
    const ids: string[] = [];
    for (const style of writes) {
      const result = (await command("styles", {
        action: "create",
        style,
      })) as unknown as MockPluginResult;
      expect(result).toMatchObject({ ok: true });
      ids.push((result.data.style as MockStyle).id);
    }
    expect(loadedFonts).toContainEqual({ family: "Inter", style: "Regular" });
    const inventory = (await command("styles", {
      action: "inspect",
    })) as unknown as MockPluginResult;
    expect(
      (inventory.data.styles as Array<{ kind: string }>).map(
        (style) => style.kind,
      ),
    ).toEqual(["PAINT", "TEXT", "EFFECT", "GRID"]);
    await expect(
      command("styles", {
        action: "update",
        styleId: ids[0],
        style: {
          kind: "PAINT",
          name: "Surface/Brand Updated",
          paints: [{ type: "SOLID", color: { r: 0.9, g: 0.8, b: 0.7 } }],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { style: { id: ids[0], name: "Surface/Brand Updated" } },
    });
    await expect(
      command("styles", { action: "delete", styleId: ids[3] }),
    ).resolves.toMatchObject({
      ok: true,
      data: { deletedStyleId: ids[3] },
    });
    await expect(
      command("styles", {
        action: "library_import",
        styleKey: "denied-style-key",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "LIBRARY_IMPORT_FAILED",
        details: {
          reason: "PLAN_ACCESS_OR_KEY",
          styleKey: "denied-style-key",
        },
      },
    });
  });

  it("manages Plugin variables with canonical modes and atomic alias validation", async () => {
    const { command, child } = createHarness();
    const createdCollection = (await command("tokens", {
      action: "collection_create",
      name: "Theme",
      initialModeName: "Light",
    })) as unknown as MockPluginResult;
    const collection = createdCollection.data
      .collection as MockVariableCollection;
    expect(collection.modes).toEqual([
      { id: collection.defaultModeId, name: "Light" },
    ]);
    const brandResult = (await command("tokens", {
      action: "variable_create",
      collectionId: collection.id,
      name: "color/brand",
      resolvedType: "COLOR",
      description: "Brand",
    })) as unknown as MockPluginResult;
    const brand = brandResult.data.variable as MockVariable;
    const accentResult = (await command("tokens", {
      action: "variable_create",
      collectionId: collection.id,
      name: "color/accent",
      resolvedType: "COLOR",
    })) as unknown as MockPluginResult;
    const accent = accentResult.data.variable as MockVariable;
    const floatResult = (await command("tokens", {
      action: "variable_create",
      collectionId: collection.id,
      name: "spacing/base",
      resolvedType: "FLOAT",
    })) as unknown as MockPluginResult;
    const floatVariable = floatResult.data.variable as MockVariable;
    const added = (await command("tokens", {
      action: "apply",
      operations: [
        { op: "mode_add", collectionId: collection.id, name: "Dark" },
      ],
    })) as unknown as MockPluginResult;
    expect(added).toMatchObject({ ok: true });
    const darkMode = (
      added.data.collections as Array<{
        id: string;
        modes: Array<{ id: string; name: string }>;
      }>
    )[0]?.modes.find((mode: { name: string }) => mode.name === "Dark");
    if (!darkMode) throw new Error("Dark mode was not created.");
    const lightValue = { r: 0.1, g: 0.2, b: 0.3, a: 1 };
    child.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    await expect(
      command("tokens", {
        action: "apply",
        operations: [
          {
            op: "set_value",
            variableId: brand.id,
            modeId: collection.defaultModeId,
            value: lightValue,
          },
          {
            op: "alias",
            variableId: accent.id,
            modeId: collection.defaultModeId,
            targetVariableId: brand.id,
          },
          {
            op: "bind",
            nodeIds: [child.id],
            field: "fills",
            variableId: accent.id,
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(child.fills).toMatchObject([
      {
        boundVariables: {
          color: { type: "VARIABLE_ALIAS", id: accent.id },
        },
      },
    ]);
    await expect(
      command("tokens", {
        action: "apply",
        operations: [
          {
            op: "alias",
            variableId: brand.id,
            modeId: collection.defaultModeId,
            targetVariableId: accent.id,
          },
        ],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    const invalid = await command("tokens", {
      action: "apply",
      operations: [
        {
          op: "set_value",
          variableId: brand.id,
          modeId: darkMode.id,
          value: { r: 1, g: 1, b: 1, a: 1 },
        },
        {
          op: "alias",
          variableId: accent.id,
          modeId: darkMode.id,
          targetVariableId: floatVariable.id,
        },
      ],
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    const invalidBinding = await command("tokens", {
      action: "apply",
      operations: [
        {
          op: "set_value",
          variableId: brand.id,
          modeId: darkMode.id,
          value: { r: 1, g: 1, b: 1, a: 1 },
        },
        {
          op: "bind",
          nodeIds: [child.id],
          field: "unsupportedField",
          variableId: brand.id,
        },
      ],
    });
    expect(invalidBinding).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    const invalidUnbind = await command("tokens", {
      action: "apply",
      operations: [
        {
          op: "set_value",
          variableId: brand.id,
          modeId: darkMode.id,
          value: { r: 1, g: 1, b: 1, a: 1 },
        },
        {
          op: "unbind",
          nodeIds: [child.id],
          field: "unsupportedField",
        },
      ],
    });
    expect(invalidUnbind).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    const inspected = (await command("tokens", {
      action: "inspect",
    })) as unknown as MockPluginResult;
    const inspectedVariables = inspected.data.variables as MockVariable[];
    expect(
      inspectedVariables.find((variable) => variable.id === brand.id)
        ?.valuesByMode[collection.defaultModeId],
    ).toEqual(lightValue);
    expect(
      inspectedVariables.find((variable) => variable.id === brand.id)
        ?.valuesByMode[darkMode.id],
    ).toBeUndefined();
    await expect(
      command("tokens", {
        action: "apply",
        operations: [
          {
            op: "mode_rename",
            collectionId: collection.id,
            modeId: darkMode.id,
            name: "Dim",
          },
          { op: "unbind", nodeIds: [child.id], field: "fills" },
          {
            op: "mode_remove",
            collectionId: collection.id,
            modeId: darkMode.id,
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(child.fills).toEqual([
      { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
    ]);
  });

  it("uses real slot nodes and returns structured library limitations", async () => {
    const { command } = createHarness();
    await expect(
      command("instance", {
        action: "slot_append",
        instanceId: "3:1",
        slotName: "Content",
        componentKey: "library-card-key",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { slot: { type: "SLOT", childCount: 1 } },
    });
    await expect(
      command("instance", {
        action: "slot_reset",
        instanceId: "3:1",
        slotName: "Content",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { slot: { type: "SLOT", childCount: 0 } },
    });
    await expect(
      command("component", { action: "library_search", query: "card" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIBRARY_SEARCH_UNAVAILABLE" },
    });
    await expect(
      command("component", {
        action: "library_import",
        componentKey: "library-card-key",
        kind: "COMPONENT",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        alreadyImported: true,
        imported: {
          source: "library",
          kind: "COMPONENT",
          nodeId: "library:card",
          key: "library-card-key",
        },
      },
    });
    await expect(
      command("component", {
        action: "library_import",
        componentKey: "denied-key",
        kind: "COMPONENT",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "LIBRARY_IMPORT_FAILED",
        details: { reason: "PLAN_ACCESS_OR_KEY" },
      },
    });
  });
});
