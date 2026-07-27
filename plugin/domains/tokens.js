// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createTokensDomain({
  figma,
  fail,
  revisionCached,
  countSceneTraversal,
  recordChange,
  nodeById,
  cloneData,
}) {
  function serializeCollection(collection) {
    return {
      id: collection.id,
      name: collection.name,
      defaultModeId: collection.defaultModeId,
      modes: collection.modes.map((mode) => ({
        id: mode.modeId,
        name: mode.name,
      })),
    };
  }

  function normalizeVariableValue(value) {
    if (typeof value === "number")
      return Math.round(value * 1_000_000) / 1_000_000;
    if (Array.isArray(value)) return value.map(normalizeVariableValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          normalizeVariableValue(item),
        ]),
      );
    return value;
  }

  function serializeVariable(variable) {
    return {
      source: variable.remote ? "library" : "local",
      id: variable.id,
      key: variable.key,
      name: variable.name,
      description: variable.description || "",
      resolvedType: variable.resolvedType,
      collectionId: variable.variableCollectionId,
      valuesByMode: normalizeVariableValue(variable.valuesByMode),
    };
  }

  async function inventory() {
    const collections =
      await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    countSceneTraversal(collections.length + variables.length);
    return { collections, variables };
  }

  function requireCollection(collections, collectionId) {
    const collection = collections.find((item) => item.id === collectionId);
    if (!collection)
      fail(
        "NODE_NOT_FOUND",
        `Variable collection ${collectionId} was not found.`,
      );
    return collection;
  }

  function requireVariable(variables, variableId) {
    const variable = variables.find((item) => item.id === variableId);
    if (!variable)
      fail("NODE_NOT_FOUND", `Variable ${variableId} was not found.`);
    return variable;
  }

  function isAlias(value) {
    return Boolean(value && value.type === "VARIABLE_ALIAS");
  }

  function validateTypedValue(variable, value) {
    const valid =
      (variable.resolvedType === "BOOLEAN" && typeof value === "boolean") ||
      (variable.resolvedType === "FLOAT" &&
        typeof value === "number" &&
        Number.isFinite(value)) ||
      (variable.resolvedType === "STRING" && typeof value === "string") ||
      (variable.resolvedType === "COLOR" &&
        value &&
        typeof value === "object" &&
        !isAlias(value) &&
        [value.r, value.g, value.b, value.a].every(
          (channel) =>
            typeof channel === "number" && channel >= 0 && channel <= 1,
        ));
    if (!valid)
      fail(
        "INVALID_ARGUMENT",
        `Variable ${variable.id} requires a ${variable.resolvedType} value.`,
      );
  }

  function bindingType(field) {
    const expected = {
      fills: "COLOR",
      strokes: "COLOR",
      opacity: "FLOAT",
      width: "FLOAT",
      height: "FLOAT",
      itemSpacing: "FLOAT",
      characters: "STRING",
      visible: "BOOLEAN",
    }[field];
    if (!expected)
      fail("INVALID_ARGUMENT", `Binding field ${field} is not supported.`);
    return expected;
  }

  function validateBinding(field, variable) {
    const expected = bindingType(field);
    if (variable.resolvedType !== expected)
      fail(
        "INVALID_ARGUMENT",
        `Binding field ${field} requires a ${expected} variable.`,
      );
  }

  function paintBindingTarget(node, field) {
    const paints = node[field];
    if (paints === figma.mixed || !Array.isArray(paints))
      fail(
        "INVALID_ARGUMENT",
        `Node ${node.id} has no concrete ${field} paints to bind.`,
      );
    const index = paints.findIndex((paint) => paint.type === "SOLID");
    if (index < 0)
      fail(
        "INVALID_ARGUMENT",
        `Node ${node.id} has no SOLID ${field} paint to bind.`,
      );
    return { paints, index };
  }

  function applyNodeBinding(node, field, variable) {
    if (field === "fills" || field === "strokes") {
      const { paints, index } = paintBindingTarget(node, field);
      node[field] = paints.map((paint, paintIndex) =>
        paintIndex === index
          ? figma.variables.setBoundVariableForPaint(paint, "color", variable)
          : paint,
      );
      return;
    }
    node.setBoundVariable(field, variable);
  }

  function validateAlias(variable, target, modeId, plannedValues) {
    if (variable.resolvedType !== target.resolvedType)
      fail(
        "INVALID_ARGUMENT",
        "Variable alias target has an incompatible resolved type.",
      );
    const visited = new Set([variable.id]);
    let currentId = target.id;
    while (currentId) {
      if (visited.has(currentId))
        fail("INVALID_ARGUMENT", "Variable alias would create a cycle.");
      visited.add(currentId);
      const value = plannedValues.get(currentId)?.[modeId];
      currentId = isAlias(value) ? value.id : undefined;
    }
  }

  async function tokensCommand(input) {
    if (input.action === "inspect") {
      return revisionCached("tokens.inventory", async () => {
        const { collections, variables } = await inventory();
        return {
          collections: collections.map(serializeCollection),
          variables: variables.map(serializeVariable),
        };
      });
    }
    if (input.dryRun)
      return {
        dryRun: true,
        action: input.action,
        operations: input.operations || [],
      };

    if (input.action === "library_import") {
      let timeout;
      try {
        const variable = await Promise.race([
          figma.variables.importVariableByKeyAsync(input.variableKey),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Figma variable import timed out.")),
              4000,
            );
          }),
        ]);
        recordChange("tokens.library_import", [variable.id]);
        return { variable: serializeVariable(variable) };
      } catch (error) {
        const timedOut = error?.message === "Figma variable import timed out.";
        fail(
          timedOut ? "UNKNOWN_OUTCOME" : "LIBRARY_IMPORT_FAILED",
          timedOut
            ? "Figma variable import timed out, but the uncancellable import may still complete."
            : "Figma could not import the published variable key.",
          false,
          {
            reason: timedOut ? "TIMEOUT_PENDING" : "PLAN_ACCESS_OR_KEY",
            variableKey: input.variableKey,
          },
        );
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }

    if (input.action === "collection_create") {
      const collection = figma.variables.createVariableCollection(input.name);
      if (input.initialModeName)
        collection.renameMode(collection.defaultModeId, input.initialModeName);
      recordChange("tokens.collection_create", [collection.id]);
      return { collection: serializeCollection(collection) };
    }

    if (input.action === "collection_update") {
      const collection = await figma.variables.getVariableCollectionByIdAsync(
        input.collectionId,
      );
      if (!collection)
        fail(
          "NODE_NOT_FOUND",
          `Variable collection ${input.collectionId} was not found.`,
        );
      collection.name = input.name;
      recordChange("tokens.collection_update", [collection.id]);
      return { collection: serializeCollection(collection) };
    }

    if (input.action === "collection_delete") {
      const collection = await figma.variables.getVariableCollectionByIdAsync(
        input.collectionId,
      );
      if (!collection)
        fail(
          "NODE_NOT_FOUND",
          `Variable collection ${input.collectionId} was not found.`,
        );
      collection.remove();
      recordChange("tokens.collection_delete", [input.collectionId]);
      return { deletedCollectionId: input.collectionId };
    }

    if (input.action === "variable_create") {
      const collection = await figma.variables.getVariableCollectionByIdAsync(
        input.collectionId,
      );
      if (!collection)
        fail(
          "NODE_NOT_FOUND",
          `Variable collection ${input.collectionId} was not found.`,
        );
      const variable = figma.variables.createVariable(
        input.name,
        collection,
        input.resolvedType,
      );
      if (input.description !== undefined)
        variable.description = input.description;
      recordChange("tokens.variable_create", [variable.id]);
      return { variable: serializeVariable(variable) };
    }

    if (input.action === "variable_update") {
      const variable = await figma.variables.getVariableByIdAsync(
        input.variableId,
      );
      if (!variable)
        fail("NODE_NOT_FOUND", `Variable ${input.variableId} was not found.`);
      if (input.name !== undefined) variable.name = input.name;
      if (input.description !== undefined)
        variable.description = input.description;
      recordChange("tokens.variable_update", [variable.id]);
      return { variable: serializeVariable(variable) };
    }

    if (input.action === "variable_delete") {
      const variable = await figma.variables.getVariableByIdAsync(
        input.variableId,
      );
      if (!variable)
        fail("NODE_NOT_FOUND", `Variable ${input.variableId} was not found.`);
      variable.remove();
      recordChange("tokens.variable_delete", [input.variableId]);
      return { deletedVariableId: input.variableId };
    }

    const { collections, variables } = await inventory();
    const plannedCollections = new Map(
      collections.map((collection) => [
        collection.id,
        {
          id: collection.id,
          defaultModeId: collection.defaultModeId,
          modes: collection.modes.map((mode) => ({
            id: mode.modeId,
            name: mode.name,
          })),
        },
      ]),
    );
    const plannedValues = new Map(
      variables.map((variable) => [
        variable.id,
        cloneData(variable.valuesByMode),
      ]),
    );
    const plannedNodes = new Map();

    for (const operation of input.operations) {
      if (operation.op === "bind" || operation.op === "unbind") {
        bindingType(operation.field);
        const variable =
          operation.op === "bind"
            ? requireVariable(variables, operation.variableId)
            : undefined;
        if (variable) validateBinding(operation.field, variable);
        for (const id of operation.nodeIds) {
          const node = await nodeById(id);
          const paintField =
            operation.field === "fills" || operation.field === "strokes";
          if (node.type === "DOCUMENT" || node.type === "PAGE")
            fail("INVALID_ARGUMENT", `Node ${id} cannot bind variables.`);
          if (paintField) paintBindingTarget(node, operation.field);
          else if (typeof node.setBoundVariable !== "function")
            fail("INVALID_ARGUMENT", `Node ${id} cannot bind variables.`);
          plannedNodes.set(id, node);
        }
        continue;
      }

      if (operation.op === "mode_add") {
        const collection = plannedCollections.get(operation.collectionId);
        if (!collection)
          fail(
            "NODE_NOT_FOUND",
            `Variable collection ${operation.collectionId} was not found.`,
          );
        if (operation.modeId)
          fail(
            "INVALID_ARGUMENT",
            "Figma assigns mode IDs; modeId is not accepted for live writes.",
          );
        continue;
      }

      if (operation.op === "mode_rename" || operation.op === "mode_remove") {
        const collection = plannedCollections.get(operation.collectionId);
        if (!collection)
          fail(
            "NODE_NOT_FOUND",
            `Variable collection ${operation.collectionId} was not found.`,
          );
        const mode = collection.modes.find(
          (candidate) => candidate.id === operation.modeId,
        );
        if (!mode)
          fail(
            "INVALID_ARGUMENT",
            `Variable mode ${operation.modeId} was not found.`,
          );
        if (operation.op === "mode_rename") mode.name = operation.name;
        else {
          if (
            collection.modes.length === 1 ||
            collection.defaultModeId === operation.modeId
          )
            fail(
              "INVALID_ARGUMENT",
              "The only or default variable mode cannot be removed.",
            );
          collection.modes = collection.modes.filter(
            (candidate) => candidate.id !== operation.modeId,
          );
          for (const variable of variables) {
            if (variable.variableCollectionId === operation.collectionId)
              delete plannedValues.get(variable.id)?.[operation.modeId];
          }
        }
        continue;
      }

      const variable = requireVariable(variables, operation.variableId);
      const collection = plannedCollections.get(variable.variableCollectionId);
      if (
        !collection?.modes.some(
          (candidate) => candidate.id === operation.modeId,
        )
      )
        fail(
          "INVALID_ARGUMENT",
          `Variable mode ${operation.modeId} was not found.`,
        );
      const directAlias =
        operation.op === "set_value" && isAlias(operation.value)
          ? operation.value.id
          : undefined;
      const targetId =
        operation.op === "alias" ? operation.targetVariableId : directAlias;
      if (targetId) {
        const target = requireVariable(variables, targetId);
        validateAlias(variable, target, operation.modeId, plannedValues);
        plannedValues.get(variable.id)[operation.modeId] = {
          type: "VARIABLE_ALIAS",
          id: target.id,
        };
      } else {
        validateTypedValue(variable, operation.value);
        plannedValues.get(variable.id)[operation.modeId] = cloneData(
          operation.value,
        );
      }
    }

    const changedIds = new Set();
    for (const operation of input.operations) {
      if (operation.op === "bind" || operation.op === "unbind") {
        const variable =
          operation.op === "bind"
            ? requireVariable(variables, operation.variableId)
            : null;
        for (const id of operation.nodeIds) {
          applyNodeBinding(plannedNodes.get(id), operation.field, variable);
          changedIds.add(id);
        }
      } else if (operation.op === "mode_add") {
        requireCollection(collections, operation.collectionId).addMode(
          operation.name,
        );
        changedIds.add(operation.collectionId);
      } else if (operation.op === "mode_rename") {
        requireCollection(collections, operation.collectionId).renameMode(
          operation.modeId,
          operation.name,
        );
        changedIds.add(operation.collectionId);
      } else if (operation.op === "mode_remove") {
        requireCollection(collections, operation.collectionId).removeMode(
          operation.modeId,
        );
        changedIds.add(operation.collectionId);
      } else {
        const variable = requireVariable(variables, operation.variableId);
        const targetId =
          operation.op === "alias"
            ? operation.targetVariableId
            : isAlias(operation.value)
              ? operation.value.id
              : undefined;
        const value = targetId
          ? figma.variables.createVariableAlias(
              requireVariable(variables, targetId),
            )
          : operation.value;
        variable.setValueForMode(operation.modeId, value);
        changedIds.add(variable.id);
      }
    }
    recordChange("tokens.apply", [...changedIds]);
    return tokensCommand({ action: "inspect" });
  }
  return { command: tokensCommand };
}
