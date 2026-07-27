import { McpFigError } from "../../errors.js";
import type {
  ComponentActionInput,
  ComponentRecord,
  FigmaNode,
  FigmaVariable,
  InstanceActionInput,
  TokenActionInput,
  VariableCollection,
  VariableValue,
} from "../types.js";
import { clone, type InMemoryStore, type StoredFile } from "./store.js";

function componentRecords(root: FigmaNode): ComponentRecord[] {
  const records: ComponentRecord[] = [];
  if (root.type === "COMPONENT" || root.type === "COMPONENT_SET") {
    records.push({
      source: "local",
      kind: root.type,
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

function newDomainId(existing: string[], prefix: string): string {
  let index = 1;
  let id = `${prefix}${index}`;
  while (existing.includes(id)) {
    index += 1;
    id = `${prefix}${index}`;
  }
  return id;
}

export class InMemoryDesignSystem {
  constructor(private readonly store: InMemoryStore) {}

  async component(
    input: ComponentActionInput,
  ): Promise<Record<string, unknown>> {
    const file =
      "dryRun" in input
        ? this.store.workingFile(input.fileKey, input.dryRun)
        : this.store.requireFile(input.fileKey);
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
    if (input.action === "library_import") {
      const component = file.libraryComponents.find(
        (candidate) => candidate.key === input.componentKey,
      );
      if (!component) {
        throw new McpFigError(
          "LIBRARY_IMPORT_FAILED",
          "Published library component was not found in the fixture inventory.",
          { details: { reason: "FIXTURE_KEY_NOT_FOUND", kind: input.kind } },
        );
      }
      const imported: ComponentRecord = {
        ...clone(component),
        source: "library",
        kind: input.kind,
      };
      const node: FigmaNode = {
        id: component.nodeId ?? `library:${input.componentKey}`,
        type: input.kind,
        name: component.name,
        componentKey: input.componentKey,
        description: component.description,
        componentProperties: clone(component.properties ?? {}),
        children: [],
      };
      return { imported, node };
    }
    if (input.action === "create_set") {
      if (Object.keys(input.axes).length === 0) {
        throw new McpFigError("INVALID_ARGUMENT", "axes cannot be empty.");
      }
      const parent = this.store.requireNode(file, input.parentId);
      parent.children ??= [];
      const componentSet: FigmaNode = {
        id: this.store.newNodeId(file),
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
          id: this.store.newNodeId(file),
          type: "COMPONENT",
          name: Object.entries(combination)
            .map(([name, value]) => `${name}=${value}`)
            .join(", "),
          parentId: componentSet.id,
          componentKey: `fixture:${this.store.newNodeId(file)}`,
          instanceProperties: combination,
          children: [],
        });
      }
      this.store.record(
        file,
        "component.create_set",
        [componentSet.id],
        input.dryRun,
      );
      return { componentSet: clone(componentSet) };
    }
    if (input.action === "arrange_set") {
      const componentSet = this.store.requireNode(file, input.componentSetId);
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
      this.store.record(
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
      if (input.property.type === "VARIANT" || input.property.type === "SLOT") {
        throw new McpFigError(
          "UNSUPPORTED_BY_BRIDGE",
          input.property.type === "VARIANT"
            ? "Figma derives VARIANT properties from component-set child names."
            : "Use slot_create so Figma creates a physical SlotNode with its property definition.",
        );
      }
      if (input.property.options && input.property.type !== "INSTANCE_SWAP") {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Preferred component keys are only valid for INSTANCE_SWAP properties; use slot_create for slots.",
        );
      }
      component.componentProperties ??= {};
      if (component.componentProperties[input.propertyName]) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Component property already exists.",
        );
      }
      component.componentProperties[input.propertyName] = clone(input.property);
    } else if (input.action === "property_update") {
      if (input.patch.type !== undefined) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Figma cannot change a component property type.",
        );
      }
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
      return {
        slots: clone(
          Object.fromEntries(
            Object.entries(component.componentProperties ?? {}).filter(
              ([, definition]) => definition.type === "SLOT",
            ),
          ),
        ),
      };
    } else {
      if (component.type !== "COMPONENT") {
        throw new McpFigError(
          "UNSUPPORTED_BY_BRIDGE",
          "Figma createSlot is available on ComponentNode, not ComponentSetNode. Target a concrete component.",
        );
      }
      component.componentProperties ??= {};
      if (component.componentProperties[input.slotName]) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Component property already exists.",
        );
      }
      component.componentProperties[input.slotName] = {
        type: "SLOT",
        defaultValue: "",
        ...(input.allowedComponentKeys
          ? { options: [...input.allowedComponentKeys] }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.slotSettings
          ? { slotSettings: clone(input.slotSettings) }
          : {}),
      };
      const slot: FigmaNode = {
        id: this.store.newNodeId(file),
        type: "SLOT",
        name: input.slotName,
        parentId: component.id,
        children: [],
      };
      component.children ??= [];
      component.children.push(slot);
      this.store.record(
        file,
        "component.slot_create",
        [component.id, slot.id],
        input.dryRun,
      );
      return {
        component: clone(this.#componentRecord(component)),
        node: clone(component),
        slot: clone(slot),
        propertyKey: input.slotName,
      };
    }
    this.store.record(
      file,
      `component.${input.action}`,
      [component.id],
      input.dryRun,
    );
    return { component: clone(this.#componentRecord(component)) };
  }

  async instance(input: InstanceActionInput): Promise<Record<string, unknown>> {
    const file =
      input.action === "inspect"
        ? this.store.requireFile(input.fileKey)
        : this.store.workingFile(input.fileKey, input.dryRun);
    if (input.action === "inspect") {
      const instances = input.instanceIds.map((id) =>
        this.store.requireNode(file, id),
      );
      if (instances.some((node) => node.type !== "INSTANCE")) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Every target must be an instance.",
        );
      }
      return { instances: clone(instances) };
    }
    if (input.action === "create") {
      const parent = this.store.requireNode(file, input.parentId);
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
        Object.entries(component.properties ?? {}).flatMap(
          ([name, property]) =>
            property.type === "SLOT" ? [] : [[name, property.defaultValue]],
        ),
      );
      const properties = { ...defaults, ...(input.properties ?? {}) };
      this.#validateProperties(component, properties);
      const localNode = local?.nodeId
        ? this.store.requireNode(file, local.nodeId)
        : undefined;
      const slotChildren: FigmaNode[] = (localNode?.children ?? [])
        .filter((child) => child.type === "SLOT")
        .map((child) => ({
          id: this.store.newNodeId(file),
          type: "SLOT",
          name: child.name,
          children: [],
        }));
      const instance: FigmaNode = {
        id: this.store.newNodeId(file),
        type: "INSTANCE",
        name: component.name,
        parentId: parent.id,
        ...(component.nodeId ? { mainComponentId: component.nodeId } : {}),
        ...(component.key ? { mainComponentKey: component.key } : {}),
        instanceProperties: properties,
        x: input.x ?? 0,
        y: input.y ?? 0,
        children: slotChildren,
      };
      for (const slot of slotChildren) slot.parentId = instance.id;
      parent.children ??= [];
      parent.children.push(instance);
      this.store.record(file, "instance.create", [instance.id], input.dryRun);
      return { instances: [clone(instance)] };
    }

    if (input.action === "swap" || input.action === "reset") {
      const instances = input.instanceIds.map((id) =>
        this.store.requireNode(file, id),
      );
      if (instances.some((node) => node.type !== "INSTANCE")) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          "Every target must be an instance.",
        );
      }
      if (input.action === "swap") {
        const target =
          componentRecords(file.document).find(
            (component) =>
              component.nodeId === input.componentId ||
              component.key === input.componentKey,
          ) ??
          file.libraryComponents.find(
            (component) => component.key === input.componentKey,
          );
        if (!target) {
          throw new McpFigError(
            "NODE_NOT_FOUND",
            "Swap component was not found.",
          );
        }
        const defaults = Object.fromEntries(
          Object.entries(target.properties ?? {}).flatMap(([name, property]) =>
            property.type === "SLOT" ? [] : [[name, property.defaultValue]],
          ),
        );
        for (const node of instances) {
          node.mainComponentId = target.nodeId;
          node.mainComponentKey = target.key;
          if (input.preserveOverrides === false)
            node.instanceProperties = defaults;
        }
      } else {
        for (const node of instances) {
          const component = this.#findComponentForInstance(file, node);
          node.instanceProperties = Object.fromEntries(
            Object.entries(component.properties ?? {}).flatMap(
              ([name, property]) =>
                property.type === "SLOT" ? [] : [[name, property.defaultValue]],
            ),
          );
        }
      }
      this.store.record(
        file,
        `instance.${input.action}`,
        input.instanceIds,
        input.dryRun,
      );
      return { instances: clone(instances) };
    }

    if (input.action === "update") {
      const instances = input.instanceIds.map((id) =>
        this.store.requireNode(file, id),
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
      this.store.record(
        file,
        "instance.update",
        input.instanceIds,
        input.dryRun,
      );
      return { instances: clone(instances) };
    }
    const instance = this.store.requireNode(file, input.instanceId);
    if (instance.type !== "INSTANCE") {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Node ${instance.id} is not an instance.`,
      );
    }
    const slot = (() => {
      const pending = [...(instance.children ?? [])];
      while (pending.length > 0) {
        const node = pending.shift();
        if (!node) continue;
        if (node.type === "SLOT" && node.name === input.slotName) return node;
        pending.push(...(node.children ?? []));
      }
      return undefined;
    })();
    if (!slot) {
      throw new McpFigError(
        "SLOT_NOT_FOUND",
        `Instance ${instance.id} has no SLOT named ${input.slotName}.`,
      );
    }
    if (input.action === "slot_append") {
      const target =
        componentRecords(file.document).find(
          (component) => component.key === input.componentKey,
        ) ??
        file.libraryComponents.find(
          (component) => component.key === input.componentKey,
        );
      if (!target) {
        throw new McpFigError(
          "NODE_NOT_FOUND",
          "Slot component was not found.",
        );
      }
      slot.children ??= [];
      slot.children.push({
        id: this.store.newNodeId(file),
        type: "INSTANCE",
        name: target.name,
        parentId: slot.id,
        mainComponentId: target.nodeId,
        mainComponentKey: target.key,
        children: [],
      });
    } else {
      slot.children = [];
    }
    this.store.record(
      file,
      `instance.${input.action}`,
      [instance.id, slot.id],
      input.dryRun,
    );
    return { instances: [clone(instance)], slot: clone(slot) };
  }

  async tokens(input: TokenActionInput): Promise<Record<string, unknown>> {
    const file =
      input.action === "inspect"
        ? this.store.requireFile(input.fileKey)
        : this.store.workingFile(input.fileKey, input.dryRun);
    if (input.action === "inspect") {
      return {
        collections: clone(file.variableCollections),
        variables: clone(file.variables),
      };
    }
    if (input.action === "collection_create") {
      const collectionId = newDomainId(
        file.variableCollections.map((collection) => collection.id),
        "collection:mcp:",
      );
      const modeId = newDomainId(
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
      this.store.record(file, "tokens.collection_create", [], input.dryRun);
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
      this.store.record(file, "tokens.collection_delete", [], input.dryRun);
      return { deletedCollectionId: input.collectionId };
    }

    const boundNodeIds: string[] = [];
    for (const operation of input.operations) {
      if (operation.op === "bind") {
        const variable = this.#requireVariable(file, operation.variableId);
        this.#validateBinding(operation.field, variable);
        for (const nodeId of operation.nodeIds) {
          const node = this.store.requireNode(file, nodeId);
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
          newDomainId(
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
    this.store.record(file, "tokens.apply", boundNodeIds, input.dryRun);
    return {
      operationsApplied: input.operations.length,
      boundNodeIds,
      collections: clone(file.variableCollections),
      variables: clone(file.variables),
    };
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
    const node = this.store.requireNode(file, componentId);
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
      if (definition.type === "SLOT") {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `${name} is a SLOT; use slot_append or slot_reset.`,
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
}
