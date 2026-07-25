import { McpFigError } from "../errors.js";
import {
  applyLayoutConfig,
  applyLayoutConstraints,
  applyLayoutSizing,
  inspectLayoutNode,
  repairLayoutScope,
  validateLayoutScope,
} from "./layout.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  ComponentActionInput,
  ComponentRecord,
  CreateNodeInput,
  DeleteNodesInput,
  FigmaBridge,
  FigmaFileFixture,
  FigmaFileSummary,
  FigmaNode,
  FigmaVariable,
  InstanceActionInput,
  LayoutActionInput,
  LayoutOperation,
  MoveNodesInput,
  ResizeNodesInput,
  TokenActionInput,
  UpdateNodesInput,
  VariableCollection,
  VariableValue,
} from "./types.js";

interface StoredFile extends FigmaFileFixture {
  selection: string[];
  libraryComponents: ComponentRecord[];
  variableCollections: VariableCollection[];
  variables: FigmaVariable[];
  revisionNumber: number;
  changes: ChangeRecord[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findNode(root: FigmaNode, nodeId: string): FigmaNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

function countNodes(root: FigmaNode): number {
  return (
    1 + (root.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
  );
}

function containsNode(root: FigmaNode, nodeId: string): boolean {
  return findNode(root, nodeId) !== undefined;
}

function nodeDepth(root: FigmaNode, nodeId: string, depth = 0): number {
  if (root.id === nodeId) return depth;
  for (const child of root.children ?? []) {
    const childDepth = nodeDepth(child, nodeId, depth + 1);
    if (childDepth >= 0) return childDepth;
  }
  return -1;
}

function componentRecords(root: FigmaNode): ComponentRecord[] {
  const records: ComponentRecord[] = [];
  if (root.type === "COMPONENT" || root.type === "COMPONENT_SET") {
    records.push({
      source: "local",
      nodeId: root.id,
      name: root.name,
      ...(root.componentKey ? { key: root.componentKey } : {}),
      ...(root.description ? { description: root.description } : {}),
      ...(root.componentProperties
        ? { properties: clone(root.componentProperties) }
        : {}),
    });
  }
  for (const child of root.children ?? []) {
    records.push(...componentRecords(child));
  }
  return records;
}

function axisCombinations(
  axes: Record<string, string[]>,
): Record<string, string>[] {
  let combinations: Record<string, string>[] = [{}];
  for (const [name, values] of Object.entries(axes)) {
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [name]: value })),
    );
  }
  return combinations;
}

export class InMemoryFigmaBridge implements FigmaBridge {
  readonly #files = new Map<string, StoredFile>();
  #activeFileKey?: string;

  constructor(fixtures: FigmaFileFixture[], activeFileKey?: string) {
    for (const fixture of fixtures) {
      this.#files.set(fixture.key, {
        ...clone(fixture),
        selection: [...(fixture.selection ?? [])],
        libraryComponents: clone(fixture.libraryComponents ?? []),
        variableCollections: clone(fixture.variableCollections ?? []),
        variables: clone(fixture.variables ?? []),
        revisionNumber: 1,
        changes: [],
      });
    }
    if (activeFileKey) {
      this.#requireFile(activeFileKey);
      this.#activeFileKey = activeFileKey;
    }
  }

  async status(): Promise<BridgeStatus> {
    const file = this.#activeFileKey
      ? this.#files.get(this.#activeFileKey)
      : undefined;
    return {
      connected: this.#files.size > 0,
      mode: "fixture",
      ...(file
        ? {
            fileKey: file.key,
            fileName: file.name,
            revision: this.#revision(file),
          }
        : {}),
      readSource: "fixture",
      writeSource: "fixture",
    };
  }

  async listFiles(): Promise<FigmaFileSummary[]> {
    return [...this.#files.values()].map((file) => ({
      key: file.key,
      name: file.name,
      revision: this.#revision(file),
    }));
  }

  async targetFile(fileKey: string): Promise<BridgeStatus> {
    this.#requireFile(fileKey);
    this.#activeFileKey = fileKey;
    return this.status();
  }

  async reconnect(): Promise<BridgeStatus> {
    return this.status();
  }

  async getDocument(fileKey?: string): Promise<FigmaNode> {
    return clone(this.#requireFile(fileKey).document);
  }

  async getSelection(fileKey?: string): Promise<string[]> {
    return [...this.#requireFile(fileKey).selection];
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    return clone(this.#requireFile(fileKey).changes);
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    const file = this.#requireFile(fileKey);
    return nodeIds.map((nodeId) => clone(this.#requireNode(file, nodeId)));
  }

  async createNode(input: CreateNodeInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const parent = this.#requireNode(file, input.parentId);
    const node: FigmaNode = {
      id: this.#newNodeId(file),
      type: input.nodeType,
      name: input.name ?? input.nodeType.toLowerCase(),
      parentId: parent.id,
      ...clone(input.props ?? {}),
      ...(this.#canHaveChildren(input.nodeType) ? { children: [] } : {}),
    };
    parent.children ??= [];
    parent.children.push(node);
    this.#record(file, "create", [node.id], input.dryRun);
    return [clone(node)];
  }

  async updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    for (const node of nodes) Object.assign(node, clone(input.patch));
    this.#record(file, "update", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async moveNodes(input: MoveNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    const destination = input.parentId
      ? this.#requireNode(file, input.parentId)
      : undefined;

    if (destination) {
      for (const node of nodes) {
        if (node.id === destination.id || containsNode(node, destination.id)) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            `Node ${node.id} cannot be moved into itself or its descendant.`,
          );
        }
      }
      destination.children ??= [];
    }

    for (const [offset, node] of nodes.entries()) {
      if (destination) {
        this.#removeFromParent(file, node);
        node.parentId = destination.id;
        const index = Math.min(
          input.index === undefined
            ? (destination.children?.length ?? 0)
            : input.index + offset,
          destination.children?.length ?? 0,
        );
        destination.children?.splice(index, 0, node);
      }
      if (input.x !== undefined) node.x = input.x;
      if (input.y !== undefined) node.y = input.y;
    }
    this.#record(file, "move", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    for (const node of nodes) {
      node.width = input.size.width;
      node.height = input.size.height;
    }
    this.#record(file, "resize", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const sourceNodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    const clones: FigmaNode[] = [];

    for (const source of sourceNodes) {
      const destination = input.parentId
        ? this.#requireNode(file, input.parentId)
        : source.parentId
          ? this.#requireNode(file, source.parentId)
          : undefined;
      if (!destination) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Root node ${source.id} cannot be cloned without a destination parent.`,
        );
      }
      destination.children ??= [];
      const copied = this.#cloneNode(file, source, destination.id);
      copied.x = (source.x ?? 0) + (input.offset?.x ?? 0);
      copied.y = (source.y ?? 0) + (input.offset?.y ?? 0);
      destination.children.push(copied);
      clones.push(copied);
    }
    this.#record(
      file,
      "clone",
      clones.map((node) => node.id),
      input.dryRun,
    );
    return clone(clones);
  }

  async deleteNodes(input: DeleteNodesInput): Promise<string[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    for (const node of nodes) {
      if (!node.parentId) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Root node ${node.id} cannot be deleted.`,
        );
      }
    }
    for (const node of nodes) this.#removeFromParent(file, node);
    file.selection = file.selection.filter(
      (nodeId) => !input.nodeIds.includes(nodeId),
    );
    this.#record(file, "delete", input.nodeIds, input.dryRun);
    return [...input.nodeIds];
  }

  async layout(input: LayoutActionInput): Promise<Record<string, unknown>> {
    const original = this.#requireFile(input.fileKey);
    if (input.action === "inspect") {
      return {
        layouts: input.nodeIds.map((nodeId) =>
          inspectLayoutNode(this.#requireNode(original, nodeId)),
        ),
      };
    }
    if (input.action === "validate") {
      return validateLayoutScope(original.document, input.nodeIds);
    }
    if (input.action === "repair") {
      const beforeValidation = validateLayoutScope(
        original.document,
        input.nodeIds,
      );
      const working = clone(original);
      const repairs = repairLayoutScope(
        working.document,
        input.nodeIds,
        input.issueCodes,
      );
      const afterValidation = validateLayoutScope(
        working.document,
        input.nodeIds,
      );
      const selectedIssueCodes = new Set(input.issueCodes);
      const unresolvedIssues = afterValidation.issues.filter((issue) =>
        selectedIssueCodes.has(issue.code),
      );
      if (repairs.length > 0 && unresolvedIssues.length > 0) {
        throw new McpFigError(
          "INTERNAL_ERROR",
          "Auto Layout repair did not clear every selected issue.",
          { details: { unresolvedIssues } },
        );
      }
      if (repairs.length > 0) {
        const repairedNodeIds = [
          ...new Set(repairs.map((repair) => repair.nodeId)),
        ];
        this.#record(working, "layout.repair", repairedNodeIds, input.dryRun);
        if (!input.dryRun) this.#files.set(working.key, working);
      }
      return {
        beforeValidation,
        repairs,
        afterValidation,
        dryRun: input.dryRun ?? false,
      };
    }

    const operations: LayoutOperation[] =
      input.action === "batch"
        ? input.operations
        : input.action === "apply"
          ? [{ op: "apply", nodeIds: input.nodeIds, layout: input.layout }]
          : [{ op: "sizing", nodeIds: input.nodeIds, sizing: input.sizing }];
    const targetIds = [
      ...new Set(operations.flatMap((operation) => operation.nodeIds)),
    ].sort((left, right) => {
      const depthDifference =
        nodeDepth(original.document, left) -
        nodeDepth(original.document, right);
      return depthDifference || left.localeCompare(right);
    });
    const before = targetIds.map((nodeId) =>
      inspectLayoutNode(this.#requireNode(original, nodeId)),
    );
    const working = clone(original);
    const phase = { apply: 0, sizing: 1, constraints: 2 } as const;
    const units = operations.flatMap((operation, operationIndex) =>
      operation.nodeIds.map((nodeId, nodeIndex) => ({
        operation,
        operationIndex,
        nodeIndex,
        nodeId,
      })),
    );
    units.sort((left, right) => {
      const phaseDifference =
        phase[left.operation.op] - phase[right.operation.op];
      if (phaseDifference !== 0) return phaseDifference;
      const depthDifference =
        nodeDepth(working.document, left.nodeId) -
        nodeDepth(working.document, right.nodeId);
      if (depthDifference !== 0) return depthDifference;
      return (
        left.operationIndex - right.operationIndex ||
        left.nodeIndex - right.nodeIndex
      );
    });

    const appliedOrder: string[] = [];
    for (const unit of units) {
      const node = this.#requireNode(working, unit.nodeId);
      if (unit.operation.op === "apply") {
        if (
          !["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(
            node.type,
          )
        ) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            `Node ${node.id} does not support Auto Layout.`,
            { details: { nodeId: node.id, nodeType: node.type } },
          );
        }
        applyLayoutConfig(node, unit.operation.layout);
      } else if (unit.operation.op === "sizing") {
        const usesAutomaticSizing =
          unit.operation.sizing.horizontal !== "FIXED" ||
          unit.operation.sizing.vertical !== "FIXED";
        if (usesAutomaticSizing) {
          const parent = node.parentId
            ? this.#requireNode(working, node.parentId)
            : undefined;
          if (!parent || (parent.layoutMode ?? "NONE") === "NONE") {
            throw new McpFigError(
              "INVALID_ARGUMENT",
              `Node ${node.id} requires an Auto Layout parent for HUG or FILL sizing.`,
              { details: { nodeId: node.id, parentId: node.parentId } },
            );
          }
        }
        applyLayoutSizing(node, unit.operation.sizing);
      } else {
        applyLayoutConstraints(node, unit.operation.constraints);
      }
      appliedOrder.push(`${unit.operation.op}:${node.id}`);
    }

    this.#record(working, `layout.${input.action}`, targetIds, input.dryRun);
    const after = targetIds.map((nodeId) =>
      inspectLayoutNode(this.#requireNode(working, nodeId)),
    );
    if (!input.dryRun) this.#files.set(working.key, working);
    return {
      before,
      after,
      appliedOrder,
      dryRun: input.dryRun ?? false,
    };
  }

  async component(
    input: ComponentActionInput,
  ): Promise<Record<string, unknown>> {
    const file =
      "dryRun" in input
        ? this.#workingFile(input.fileKey, input.dryRun)
        : this.#requireFile(input.fileKey);
    const local = componentRecords(file.document);

    if (input.action === "search" || input.action === "library_search") {
      const source = input.action === "search" ? local : file.libraryComponents;
      const query = input.query?.toLowerCase();
      return {
        components: clone(
          query
            ? source.filter((component) =>
                component.name.toLowerCase().includes(query),
              )
            : source,
        ),
      };
    }
    if (input.action === "inspect" || input.action === "library_inspect") {
      const component =
        input.action === "library_inspect"
          ? file.libraryComponents.find(
              (candidate) => candidate.key === input.componentKey,
            )
          : local.find(
              (candidate) =>
                candidate.nodeId === input.componentId ||
                candidate.key === input.componentKey,
            );
      if (!component) {
        throw new McpFigError(
          "NODE_NOT_FOUND",
          "Figma component was not found.",
        );
      }
      return { component: clone(component) };
    }
    if (input.action === "create_set") {
      if (Object.keys(input.axes).length === 0) {
        throw new McpFigError("INVALID_ARGUMENT", "axes cannot be empty.");
      }
      const parent = this.#requireNode(file, input.parentId);
      parent.children ??= [];
      const componentSet: FigmaNode = {
        id: this.#newNodeId(file),
        type: "COMPONENT_SET",
        name: input.name,
        parentId: parent.id,
        componentProperties: Object.fromEntries(
          Object.entries(input.axes).map(([name, options]) => [
            name,
            { type: "VARIANT", defaultValue: options[0] ?? "", options },
          ]),
        ),
        children: [],
      };
      parent.children.push(componentSet);
      for (const combination of axisCombinations(input.axes)) {
        componentSet.children?.push({
          id: this.#newNodeId(file),
          type: "COMPONENT",
          name: Object.entries(combination)
            .map(([name, value]) => `${name}=${value}`)
            .join(", "),
          parentId: componentSet.id,
          componentKey: `fixture:${this.#newNodeId(file)}`,
          instanceProperties: combination,
          children: [],
        });
      }
      this.#record(
        file,
        "component.create_set",
        [componentSet.id],
        input.dryRun,
      );
      return { componentSet: clone(componentSet) };
    }
    if (input.action === "arrange_set") {
      const componentSet = this.#requireNode(file, input.componentSetId);
      if (componentSet.type !== "COMPONENT_SET") {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Target is not a component set.",
        );
      }
      const columns =
        input.columns ?? Math.max(1, componentSet.children?.length ?? 1);
      const gap = input.gap ?? 24;
      for (const [index, child] of (componentSet.children ?? []).entries()) {
        child.x = (index % columns) * ((child.width ?? 100) + gap);
        child.y = Math.floor(index / columns) * ((child.height ?? 40) + gap);
      }
      this.#record(
        file,
        "component.arrange_set",
        [componentSet.id],
        input.dryRun,
      );
      return { componentSet: clone(componentSet) };
    }

    const component = this.#requireComponentNode(file, input.componentId);
    if (input.action === "set_description") {
      component.description = input.description;
    } else if (input.action === "property_add") {
      component.componentProperties ??= {};
      if (component.componentProperties[input.propertyName]) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Component property already exists.",
        );
      }
      component.componentProperties[input.propertyName] = clone(input.property);
    } else if (input.action === "property_update") {
      const property = component.componentProperties?.[input.propertyName];
      if (!property) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Component property was not found.",
        );
      }
      Object.assign(property, clone(input.patch));
    } else if (input.action === "property_delete") {
      if (!component.componentProperties?.[input.propertyName]) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Component property was not found.",
        );
      }
      delete component.componentProperties[input.propertyName];
    } else if (input.action === "slots") {
      return { slots: clone(component.componentSlots ?? {}) };
    } else {
      component.componentSlots ??= {};
      component.componentSlots[input.slotName] = [
        ...(input.allowedComponentKeys ?? []),
      ];
    }
    this.#record(
      file,
      `component.${input.action}`,
      [component.id],
      input.dryRun,
    );
    return { component: clone(this.#componentRecord(component)) };
  }

  async instance(input: InstanceActionInput): Promise<Record<string, unknown>> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    if (input.action === "create") {
      const parent = this.#requireNode(file, input.parentId);
      const local = componentRecords(file.document).find(
        (component) =>
          component.nodeId === input.componentId ||
          component.key === input.componentKey,
      );
      const library = file.libraryComponents.find(
        (component) => component.key === input.componentKey,
      );
      const component = local ?? library;
      if (!component) {
        throw new McpFigError(
          "NODE_NOT_FOUND",
          "Figma component was not found.",
        );
      }
      const defaults = Object.fromEntries(
        Object.entries(component.properties ?? {}).map(([name, property]) => [
          name,
          property.defaultValue,
        ]),
      );
      const properties = { ...defaults, ...(input.properties ?? {}) };
      this.#validateProperties(component, properties);
      const instance: FigmaNode = {
        id: this.#newNodeId(file),
        type: "INSTANCE",
        name: component.name,
        parentId: parent.id,
        ...(component.nodeId ? { mainComponentId: component.nodeId } : {}),
        ...(component.key ? { mainComponentKey: component.key } : {}),
        instanceProperties: properties,
        x: input.x ?? 0,
        y: input.y ?? 0,
        children: [],
      };
      parent.children ??= [];
      parent.children.push(instance);
      this.#record(file, "instance.create", [instance.id], input.dryRun);
      return { instances: [clone(instance)] };
    }

    if (input.action === "update") {
      const instances = input.instanceIds.map((id) =>
        this.#requireNode(file, id),
      );
      for (const node of instances) {
        if (node.type !== "INSTANCE") {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            `Node ${node.id} is not an instance.`,
          );
        }
        const component = this.#findComponentForInstance(file, node);
        const properties = {
          ...(node.instanceProperties ?? {}),
          ...input.properties,
        };
        this.#validateProperties(component, properties);
        node.instanceProperties = properties;
      }
      this.#record(file, "instance.update", input.instanceIds, input.dryRun);
      return { instances: clone(instances) };
    }
    const instance = this.#requireNode(file, input.instanceId);
    if (instance.type !== "INSTANCE") {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Node ${instance.id} is not an instance.`,
      );
    }
    instance.componentSlots ??= {};
    if (input.action === "slot_append") {
      instance.componentSlots[input.slotName] ??= [];
      instance.componentSlots[input.slotName]?.push(input.componentKey);
    } else {
      delete instance.componentSlots[input.slotName];
    }
    this.#record(file, `instance.${input.action}`, [instance.id], input.dryRun);
    return { instances: [clone(instance)] };
  }

  async tokens(input: TokenActionInput): Promise<Record<string, unknown>> {
    const file =
      input.action === "inspect"
        ? this.#requireFile(input.fileKey)
        : this.#workingFile(input.fileKey, input.dryRun);
    if (input.action === "inspect") {
      return {
        collections: clone(file.variableCollections),
        variables: clone(file.variables),
      };
    }
    if (input.action === "collection_create") {
      const collectionId = this.#newDomainId(
        file.variableCollections.map((collection) => collection.id),
        "collection:mcp:",
      );
      const modeId = this.#newDomainId(
        file.variableCollections.flatMap((collection) =>
          collection.modes.map((mode) => mode.id),
        ),
        "mode:mcp:",
      );
      const collection: VariableCollection = {
        id: collectionId,
        name: input.name,
        defaultModeId: modeId,
        modes: [{ id: modeId, name: input.initialModeName ?? "Default" }],
      };
      file.variableCollections.push(collection);
      this.#record(file, "tokens.collection_create", [], input.dryRun);
      return { collection: clone(collection) };
    }
    if (input.action === "collection_delete") {
      const index = file.variableCollections.findIndex(
        (collection) => collection.id === input.collectionId,
      );
      if (index < 0) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Variable collection was not found.",
        );
      }
      file.variableCollections.splice(index, 1);
      file.variables = file.variables.filter(
        (variable) => variable.collectionId !== input.collectionId,
      );
      this.#record(file, "tokens.collection_delete", [], input.dryRun);
      return { deletedCollectionId: input.collectionId };
    }

    const boundNodeIds: string[] = [];
    for (const operation of input.operations) {
      if (operation.op === "bind") {
        const variable = this.#requireVariable(file, operation.variableId);
        this.#validateBinding(operation.field, variable);
        for (const nodeId of operation.nodeIds) {
          const node = this.#requireNode(file, nodeId);
          node.boundVariables ??= {};
          node.boundVariables[operation.field] = operation.variableId;
          boundNodeIds.push(nodeId);
        }
      } else if (operation.op === "mode_add") {
        const collection = this.#requireCollection(
          file,
          operation.collectionId,
        );
        const modeId =
          operation.modeId ??
          this.#newDomainId(
            file.variableCollections.flatMap((candidate) =>
              candidate.modes.map((mode) => mode.id),
            ),
            "mode:mcp:",
          );
        if (collection.modes.some((mode) => mode.id === modeId)) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            "Variable mode already exists.",
          );
        }
        collection.modes.push({ id: modeId, name: operation.name });
      } else if (operation.op === "mode_rename") {
        const collection = this.#requireCollection(
          file,
          operation.collectionId,
        );
        const mode = collection.modes.find(
          (candidate) => candidate.id === operation.modeId,
        );
        if (!mode) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            "Variable mode was not found.",
          );
        }
        mode.name = operation.name;
      } else {
        const variable = this.#requireVariable(file, operation.variableId);
        const collection = this.#requireCollection(file, variable.collectionId);
        if (!collection.modes.some((mode) => mode.id === operation.modeId)) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            "Variable mode was not found.",
          );
        }
        if (operation.op === "alias") {
          const target = this.#requireVariable(
            file,
            operation.targetVariableId,
          );
          if (
            target.id === variable.id ||
            target.resolvedType !== variable.resolvedType
          ) {
            throw new McpFigError(
              "INVALID_ARGUMENT",
              "Variable alias target is incompatible.",
            );
          }
          this.#validateAlias(file, variable.id, target.id, operation.modeId);
          variable.valuesByMode[operation.modeId] = {
            type: "VARIABLE_ALIAS",
            id: target.id,
          };
        } else {
          variable.valuesByMode[operation.modeId] = clone(operation.value);
        }
      }
    }
    this.#record(file, "tokens.apply", boundNodeIds, input.dryRun);
    return {
      operationsApplied: input.operations.length,
      boundNodeIds,
      collections: clone(file.variableCollections),
      variables: clone(file.variables),
    };
  }

  countNodes(fileKey?: string): number {
    return countNodes(this.#requireFile(fileKey).document);
  }

  #componentRecord(node: FigmaNode): ComponentRecord {
    return {
      source: "local",
      nodeId: node.id,
      name: node.name,
      ...(node.componentKey ? { key: node.componentKey } : {}),
      ...(node.description ? { description: node.description } : {}),
      ...(node.componentProperties
        ? { properties: clone(node.componentProperties) }
        : {}),
    };
  }

  #requireComponentNode(file: StoredFile, componentId: string): FigmaNode {
    const node = this.#requireNode(file, componentId);
    if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Node ${componentId} is not a component.`,
      );
    }
    return node;
  }

  #findComponentForInstance(
    file: StoredFile,
    instance: FigmaNode,
  ): ComponentRecord {
    const component =
      componentRecords(file.document).find(
        (candidate) =>
          candidate.nodeId === instance.mainComponentId ||
          candidate.key === instance.mainComponentKey,
      ) ??
      file.libraryComponents.find(
        (candidate) => candidate.key === instance.mainComponentKey,
      );
    if (!component) {
      throw new McpFigError("NODE_NOT_FOUND", "Main component was not found.");
    }
    return component;
  }

  #validateProperties(
    component: ComponentRecord,
    properties: Record<string, string | boolean>,
  ): void {
    if (!component.properties) return;
    for (const [name, value] of Object.entries(properties)) {
      const definition = component.properties[name];
      if (!definition) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Component property ${name} was not found.`,
        );
      }
      if (definition.type === "BOOLEAN" && typeof value !== "boolean") {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `${name} requires a boolean value.`,
        );
      }
      if (
        definition.options &&
        typeof value === "string" &&
        !definition.options.includes(value)
      ) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `${name} does not allow value ${value}.`,
        );
      }
    }
  }

  #validateBinding(field: string, variable: FigmaVariable): void {
    const expectedType: Partial<Record<string, FigmaVariable["resolvedType"]>> =
      {
        fills: "COLOR",
        strokes: "COLOR",
        opacity: "FLOAT",
        width: "FLOAT",
        height: "FLOAT",
        visible: "BOOLEAN",
        text: "STRING",
      };
    const expected = expectedType[field];
    if (expected && variable.resolvedType !== expected) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Field ${field} requires a ${expected} variable.`,
      );
    }
  }

  #validateAlias(
    file: StoredFile,
    variableId: string,
    targetVariableId: string,
    modeId: string,
  ): void {
    const visited = new Set([variableId]);
    let currentId: string | undefined = targetVariableId;
    while (currentId) {
      if (visited.has(currentId)) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Variable alias would create a cycle.",
        );
      }
      visited.add(currentId);
      const value: VariableValue | undefined = this.#requireVariable(
        file,
        currentId,
      ).valuesByMode[modeId];
      currentId =
        typeof value === "object" && value.type === "VARIABLE_ALIAS"
          ? value.id
          : undefined;
    }
  }

  #requireVariable(file: StoredFile, variableId: string): FigmaVariable {
    const variable = file.variables.find(
      (candidate) => candidate.id === variableId,
    );
    if (!variable) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Variable ${variableId} was not found.`,
      );
    }
    return variable;
  }

  #requireCollection(
    file: StoredFile,
    collectionId: string,
  ): VariableCollection {
    const collection = file.variableCollections.find(
      (candidate) => candidate.id === collectionId,
    );
    if (!collection) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Variable collection ${collectionId} was not found.`,
      );
    }
    return collection;
  }

  #requireFile(fileKey?: string): StoredFile {
    const key = fileKey ?? this.#activeFileKey;
    if (!key) {
      throw new McpFigError(
        "FILE_NOT_TARGETED",
        "No Figma file is targeted. Use figma_connection.target first.",
      );
    }
    const file = this.#files.get(key);
    if (!file) {
      throw new McpFigError(
        "FILE_NOT_FOUND",
        `Figma file ${key} was not found.`,
        {
          details: { fileKey: key },
        },
      );
    }
    return file;
  }

  #requireNode(file: StoredFile, nodeId: string): FigmaNode {
    const node = findNode(file.document, nodeId);
    if (!node) {
      throw new McpFigError(
        "NODE_NOT_FOUND",
        `Figma node ${nodeId} was not found.`,
        {
          details: { fileKey: file.key, nodeId },
        },
      );
    }
    return node;
  }

  #workingFile(fileKey: string | undefined, dryRun = false): StoredFile {
    const file = this.#requireFile(fileKey);
    return dryRun ? clone(file) : file;
  }

  #removeFromParent(file: StoredFile, node: FigmaNode): void {
    if (!node.parentId) return;
    const parent = this.#requireNode(file, node.parentId);
    const index =
      parent.children?.findIndex((child) => child.id === node.id) ?? -1;
    if (index >= 0) parent.children?.splice(index, 1);
  }

  #cloneNode(
    file: StoredFile,
    source: FigmaNode,
    parentId: string,
    reserved = new Set<string>(),
  ): FigmaNode {
    const copied: FigmaNode = {
      ...clone(source),
      id: this.#newNodeId(file, reserved),
      parentId,
    };
    if (source.children) {
      copied.children = source.children.map((child) =>
        this.#cloneNode(file, child, copied.id, reserved),
      );
    }
    return copied;
  }

  #newNodeId(file: StoredFile, reserved = new Set<string>()): string {
    let index = 1;
    let nodeId = `mcp:${index}`;
    while (findNode(file.document, nodeId) || reserved.has(nodeId)) {
      index += 1;
      nodeId = `mcp:${index}`;
    }
    reserved.add(nodeId);
    return nodeId;
  }

  #newDomainId(existing: string[], prefix: string): string {
    let index = 1;
    let id = `${prefix}${index}`;
    while (existing.includes(id)) {
      index += 1;
      id = `${prefix}${index}`;
    }
    return id;
  }

  #record(
    file: StoredFile,
    action: string,
    nodeIds: string[],
    dryRun = false,
  ): void {
    if (dryRun) return;
    file.revisionNumber += 1;
    file.changes.push({
      revision: this.#revision(file),
      action,
      nodeIds: [...nodeIds],
      timestamp: new Date().toISOString(),
    });
  }

  #revision(file: StoredFile): string {
    return `fixture-r${file.revisionNumber}`;
  }

  #canHaveChildren(type: FigmaNode["type"]): boolean {
    return ["DOCUMENT", "PAGE", "FRAME", "GROUP", "COMPONENT"].includes(type);
  }
}
