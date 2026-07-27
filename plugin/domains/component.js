// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createComponentDomain({
  figma,
  fail,
  revisionCached,
  countSceneTraversal,
  recordChange,
  nodeById,
  hasChildren,
  serializeNode,
}) {
  function definitionsFor(node) {
    try {
      return node.componentPropertyDefinitions || {};
    } catch {
      if (node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET")
        return node.parent.componentPropertyDefinitions || {};
      return {};
    }
  }

  function componentProperties(definitions) {
    return Object.fromEntries(
      Object.entries(definitions || {}).map(([name, definition]) => [
        name,
        {
          type: definition.type,
          defaultValue: definition.defaultValue,
          ...(definition.variantOptions
            ? { options: [...definition.variantOptions] }
            : definition.preferredValues
              ? {
                  options: definition.preferredValues.map((value) => value.key),
                }
              : {}),
          ...(definition.description !== undefined
            ? { description: definition.description }
            : {}),
          ...(definition.slotSettings
            ? { slotSettings: { ...definition.slotSettings } }
            : {}),
        },
      ]),
    );
  }

  async function importPublishedComponent(componentKey, kind) {
    let timeout;
    try {
      return await Promise.race([
        kind === "COMPONENT"
          ? figma.importComponentByKeyAsync(componentKey)
          : figma.importComponentSetByKeyAsync(componentKey),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Figma library import timed out.")),
            4000,
          );
        }),
      ]);
    } catch (error) {
      const timedOut = error?.message === "Figma library import timed out.";
      fail(
        timedOut ? "UNKNOWN_OUTCOME" : "LIBRARY_IMPORT_FAILED",
        timedOut
          ? "Figma library import timed out, but the uncancellable import may still complete."
          : "Figma could not import the published component key.",
        false,
        {
          reason: timedOut ? "TIMEOUT_PENDING" : "PLAN_ACCESS_OR_KEY",
          kind,
          componentKey,
        },
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function localComponents() {
    await figma.loadAllPagesAsync();
    return figma.root.findAllWithCriteria({
      types: ["COMPONENT", "COMPONENT_SET"],
    });
  }

  /** @param {ComponentNode | ComponentSetNode} node */
  function componentRecord(node) {
    return {
      source: node.remote ? "library" : "local",
      kind: node.type,
      name: node.name,
      nodeId: node.id,
      key: node.key,
      description: node.description,
      properties: componentProperties(definitionsFor(node)),
    };
  }

  async function componentCommand(input) {
    if (input.action === "search") {
      const query = (input.query || "").toLowerCase();
      const inventory = await revisionCached(
        "component.inventory",
        async () => {
          const components = await localComponents();
          countSceneTraversal(components.length);
          return components.map(componentRecord);
        },
      );
      return {
        components: inventory.filter((component) =>
          component.name.toLowerCase().includes(query),
        ),
      };
    }
    if (input.action === "inspect") {
      let node;
      if (input.componentId) node = await nodeById(input.componentId);
      else {
        const components = await localComponents();
        countSceneTraversal(components.length);
        node = components.find((item) => item.key === input.componentKey);
      }
      if (node?.type !== "COMPONENT" && node?.type !== "COMPONENT_SET")
        fail("NODE_NOT_FOUND", "Component or component set was not found.");
      return {
        component: componentRecord(node),
        node: await serializeNode(node, true),
      };
    }
    if (
      input.action === "library_search" ||
      input.action === "library_inspect"
    ) {
      fail(
        "LIBRARY_SEARCH_UNAVAILABLE",
        "Figma Plugin API cannot enumerate component libraries. Use a published key with library_import.",
        false,
        { reason: "NO_COMPONENT_LIBRARY_INVENTORY_API" },
      );
    }
    if (input.action === "library_import") {
      if (input.dryRun)
        return {
          dryRun: true,
          action: input.action,
          componentKey: input.componentKey,
          kind: input.kind,
        };
      const imported = await importPublishedComponent(
        input.componentKey,
        input.kind,
      );
      recordChange("component.library_import", [imported.id]);
      return {
        imported: componentRecord(imported),
        node: await serializeNode(imported, true),
      };
    }
    if (input.dryRun) return { dryRun: true, action: input.action };
    if (input.action === "create_set") {
      const parent = await nodeById(input.parentId);
      if (!hasChildren(parent))
        fail(
          "INVALID_ARGUMENT",
          "Component set parent cannot contain children.",
        );
      const entries = Object.entries(input.axes);
      if (
        entries.length < 1 ||
        entries.length > 8 ||
        entries.some(
          ([axis, values]) =>
            !axis.trim() ||
            !Array.isArray(values) ||
            values.length < 1 ||
            values.length > 20 ||
            new Set(values).size !== values.length,
        )
      )
        fail(
          "INVALID_ARGUMENT",
          "Component set requires 1 to 8 axes with 1 to 20 unique values each.",
        );
      const combinations = entries.reduce(
        (sets, [axis, values]) =>
          sets.flatMap((combination) =>
            values.map((value) => ({ ...combination, [axis]: value })),
          ),
        [{}],
      );
      if (combinations.length > 100)
        fail(
          "INVALID_ARGUMENT",
          "A component set may contain at most 100 variants.",
        );
      const variants = [];
      let set;
      try {
        for (const combination of combinations) {
          const component = figma.createComponent();
          variants.push(component);
          component.name = Object.entries(combination)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ");
          parent.appendChild(component);
        }
        set = figma.combineAsVariants(variants, parent);
        set.name = input.name;
        recordChange("component.create_set", [set.id]);
        return { componentSet: await serializeNode(set, true) };
      } catch (error) {
        if (set?.parent) set.remove();
        else {
          for (const variant of variants) {
            if (variant.parent && variant.type === "COMPONENT")
              variant.remove();
          }
        }
        throw error;
      }
    }
    if (input.action === "arrange_set") {
      const set = await nodeById(input.componentSetId);
      if (set.type !== "COMPONENT_SET")
        fail("INVALID_ARGUMENT", "Target is not a component set.");
      const columns =
        input.columns || Math.ceil(Math.sqrt(set.children.length));
      const gap = input.gap ?? 24;
      set.children.forEach((child, index) => {
        child.x = (index % columns) * (child.width + gap);
        child.y = Math.floor(index / columns) * (child.height + gap);
      });
      recordChange("component.arrange_set", [set.id]);
      return { componentSet: await serializeNode(set, true) };
    }
    const component = await nodeById(input.componentId);
    if (component.type !== "COMPONENT" && component.type !== "COMPONENT_SET")
      fail("INVALID_ARGUMENT", "Target is not a component or component set.");
    if (input.action === "set_description")
      component.description = input.description;
    if (input.action === "property_add") {
      if (definitionsFor(component)[input.propertyName])
        fail("INVALID_ARGUMENT", "Component property already exists.");
      if (input.property.type === "VARIANT" || input.property.type === "SLOT")
        fail(
          "UNSUPPORTED_BY_BRIDGE",
          input.property.type === "VARIANT"
            ? "Figma derives VARIANT properties from component-set child names."
            : "Use slot_create so Figma creates a physical SlotNode with its property definition.",
        );
      if (
        input.property.options &&
        input.property.type !== "INSTANCE_SWAP" &&
        input.property.type !== "SLOT"
      )
        fail(
          "INVALID_ARGUMENT",
          "Preferred component keys are only valid for INSTANCE_SWAP and SLOT properties.",
        );
      component.addComponentProperty(
        input.propertyName,
        input.property.type,
        input.property.defaultValue,
        {
          ...(input.property.options
            ? {
                preferredValues: input.property.options.map((key) => ({
                  type: "COMPONENT",
                  key,
                })),
              }
            : {}),
          ...(input.property.description !== undefined
            ? { description: input.property.description }
            : {}),
          ...(input.property.slotSettings
            ? { slotSettings: input.property.slotSettings }
            : {}),
        },
      );
    }
    if (input.action === "property_update") {
      if (!definitionsFor(component)[input.propertyName])
        fail("INVALID_ARGUMENT", "Component property was not found.");
      if (input.patch.type !== undefined)
        fail(
          "INVALID_ARGUMENT",
          "Figma cannot change a component property type.",
        );
      component.editComponentProperty(input.propertyName, {
        ...(input.patch.defaultValue !== undefined
          ? { defaultValue: input.patch.defaultValue }
          : {}),
        ...(input.patch.options
          ? {
              preferredValues: input.patch.options.map((key) => ({
                type: "COMPONENT",
                key,
              })),
            }
          : {}),
        ...(input.patch.description !== undefined
          ? { description: input.patch.description }
          : {}),
        ...(input.patch.slotSettings
          ? { slotSettings: input.patch.slotSettings }
          : {}),
      });
    }
    if (input.action === "property_delete") {
      if (!definitionsFor(component)[input.propertyName])
        fail("INVALID_ARGUMENT", "Component property was not found.");
      component.deleteComponentProperty(input.propertyName);
    }
    if (input.action === "slots")
      return {
        slots: Object.fromEntries(
          Object.entries(componentProperties(definitionsFor(component))).filter(
            ([, definition]) => definition.type === "SLOT",
          ),
        ),
      };
    if (input.action === "slot_create") {
      if (component.type !== "COMPONENT")
        fail(
          "UNSUPPORTED_BY_BRIDGE",
          "Figma createSlot is available on ComponentNode, not ComponentSetNode. Target a concrete component.",
        );
      if (
        Object.keys(definitionsFor(component)).some(
          (key) =>
            key === input.slotName || key.split("#")[0] === input.slotName,
        )
      )
        fail("INVALID_ARGUMENT", "Component property already exists.");
      const definitionsBefore = new Set(Object.keys(definitionsFor(component)));
      const slot = component.createSlot();
      try {
        const createdDefinitionKeys = Object.entries(definitionsFor(component))
          .filter(
            ([key, definition]) =>
              !definitionsBefore.has(key) && definition.type === "SLOT",
          )
          .map(([key]) => key);
        const initialKey =
          slot.componentPropertyReferences?.slot ??
          (createdDefinitionKeys.length === 1
            ? createdDefinitionKeys[0]
            : undefined);
        if (!initialKey)
          fail(
            "INTERNAL_ERROR",
            "Figma created a SlotNode without a slot property reference.",
          );
        slot.name = input.slotName;
        const currentDefinitionKeys = Object.entries(definitionsFor(component))
          .filter(
            ([key, definition]) =>
              !definitionsBefore.has(key) && definition.type === "SLOT",
          )
          .map(([key]) => key);
        const currentKey =
          currentDefinitionKeys.length === 1
            ? currentDefinitionKeys[0]
            : definitionsFor(component)[initialKey]
              ? initialKey
              : undefined;
        if (!currentKey)
          fail(
            "INTERNAL_ERROR",
            "Figma renamed the SlotNode without exposing its current property key.",
          );
        const propertyKey = component.editComponentProperty(currentKey, {
          ...(input.allowedComponentKeys
            ? {
                preferredValues: input.allowedComponentKeys.map((key) => ({
                  type: "COMPONENT",
                  key,
                })),
              }
            : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.slotSettings ? { slotSettings: input.slotSettings } : {}),
        });
        recordChange("component.slot_create", [component.id, slot.id]);
        return {
          component: componentRecord(component),
          node: await serializeNode(component, true),
          slot: await serializeNode(slot, true),
          propertyKey,
        };
      } catch (error) {
        let createdKeys = [];
        try {
          createdKeys = Object.entries(definitionsFor(component))
            .filter(
              ([key, definition]) =>
                !definitionsBefore.has(key) && definition.type === "SLOT",
            )
            .map(([key]) => key);
        } catch {}
        if (slot.parent) slot.remove();
        for (const key of createdKeys) {
          try {
            if (definitionsFor(component)[key])
              component.deleteComponentProperty(key);
          } catch {}
        }
        throw error;
      }
    }
    recordChange(`component.${input.action}`, [component.id]);
    return {
      component: componentRecord(component),
      node: await serializeNode(component),
    };
  }

  async function resolveComponent(input) {
    if (input.componentId) {
      const node = await nodeById(input.componentId);
      if (node.type !== "COMPONENT")
        fail("INVALID_ARGUMENT", "Target is not a component.");
      return node;
    }
    if (input.componentKey) {
      const components = await localComponents();
      const local = components.find(
        (component) =>
          component.type === "COMPONENT" &&
          component.key === input.componentKey,
      );
      if (local) return local;
      return importPublishedComponent(input.componentKey, "COMPONENT");
    }
    fail("INVALID_ARGUMENT", "componentId or componentKey is required.");
  }
  return { command: componentCommand, resolveComponent };
}
