// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createTokensDomain({
  figma,
  fail,
  revisionCached,
  countSceneTraversal,
  recordChange,
  nodeById,
}) {
  async function tokensCommand(input) {
    if (input.action === "inspect") {
      return revisionCached("tokens.inventory", async () => {
        const collections =
          await figma.variables.getLocalVariableCollectionsAsync();
        const variables = await figma.variables.getLocalVariablesAsync();
        countSceneTraversal(collections.length + variables.length);
        return {
          collections: collections.map((item) => ({
            id: item.id,
            name: item.name,
            defaultModeId: item.defaultModeId,
            modes: item.modes,
          })),
          variables: variables.map((item) => ({
            id: item.id,
            key: item.key,
            name: item.name,
            resolvedType: item.resolvedType,
            collectionId: item.variableCollectionId,
            valuesByMode: item.valuesByMode,
          })),
        };
      });
    }
    if (input.dryRun)
      return {
        dryRun: true,
        action: input.action,
        operations: input.operations || [],
      };
    if (input.action === "collection_create") {
      const collection = figma.variables.createVariableCollection(input.name);
      if (input.initialModeName)
        collection.renameMode(collection.defaultModeId, input.initialModeName);
      recordChange("tokens.collection_create", [collection.id]);
      return {
        collection: {
          id: collection.id,
          name: collection.name,
          defaultModeId: collection.defaultModeId,
          modes: collection.modes,
        },
      };
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
    for (const operation of input.operations) {
      if (operation.op === "bind") {
        const variable = await figma.variables.getVariableByIdAsync(
          operation.variableId,
        );
        if (!variable)
          fail(
            "NODE_NOT_FOUND",
            `Variable ${operation.variableId} was not found.`,
          );
        for (const id of operation.nodeIds) {
          const node = await nodeById(id);
          if (node.type === "DOCUMENT" || node.type === "PAGE")
            fail("INVALID_ARGUMENT", `Node ${id} cannot bind variables.`);
          node.setBoundVariable(operation.field, variable);
        }
      }
      if (operation.op === "set_value" || operation.op === "alias") {
        const variable = await figma.variables.getVariableByIdAsync(
          operation.variableId,
        );
        if (!variable)
          fail(
            "NODE_NOT_FOUND",
            `Variable ${operation.variableId} was not found.`,
          );
        const value =
          operation.op === "alias"
            ? figma.variables.createVariableAlias(
                await figma.variables.getVariableByIdAsync(
                  operation.targetVariableId,
                ),
              )
            : operation.value;
        variable.setValueForMode(operation.modeId, value);
      }
      if (operation.op === "mode_add" || operation.op === "mode_rename") {
        const collection = await figma.variables.getVariableCollectionByIdAsync(
          operation.collectionId,
        );
        if (!collection)
          fail(
            "NODE_NOT_FOUND",
            `Variable collection ${operation.collectionId} was not found.`,
          );
        if (operation.op === "mode_add") collection.addMode(operation.name);
        else collection.renameMode(operation.modeId, operation.name);
      }
    }
    recordChange("tokens.apply", []);
    return tokensCommand({ action: "inspect" });
  }
  return { command: tokensCommand };
}
