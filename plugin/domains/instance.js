// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createInstanceDomain({
  fail,
  assertNodeIds,
  recordChange,
  nodeById,
  hasChildren,
  serializeNode,
  resolveComponent,
}) {
  function slotIn(node, slotName) {
    if (
      node.type === "SLOT" &&
      (node.name === slotName ||
        node.componentPropertyReferences?.slot === slotName ||
        node.componentPropertyReferences?.slot?.split("#")[0] === slotName)
    )
      return node;
    if (!hasChildren(node)) return undefined;
    for (const child of node.children) {
      const found = slotIn(child, slotName);
      if (found) return found;
    }
    return undefined;
  }

  async function requireInstances(ids) {
    assertNodeIds(ids);
    return Promise.all(
      ids.map(async (id) => {
        const node = await nodeById(id);
        if (node.type !== "INSTANCE")
          fail("INVALID_ARGUMENT", "Every target must be an instance.");
        return node;
      }),
    );
  }

  function propertyValues(instance) {
    return Object.fromEntries(
      Object.entries(instance.componentProperties || {}).flatMap(
        ([key, value]) => (value.type === "SLOT" ? [] : [[key, value.value]]),
      ),
    );
  }

  function resolvePropertyPatch(instance, properties) {
    const available = Object.keys(instance.componentProperties || {});
    return Object.fromEntries(
      Object.entries(properties).map(([requested, value]) => {
        let resolved = requested;
        if (!available.includes(requested)) {
          const matches = available.filter(
            (key) => key.split("#")[0] === requested,
          );
          if (matches.length !== 1)
            fail(
              "INVALID_ARGUMENT",
              matches.length
                ? `Component property name ${requested} is ambiguous.`
                : `Component property ${requested} does not exist on instance ${instance.id}.`,
              false,
              {
                requested,
                matches,
                available: available.map((key) => ({
                  key,
                  name: key.split("#")[0],
                })),
              },
            );
          resolved = matches[0];
        }
        if (instance.componentProperties?.[resolved]?.type === "SLOT")
          fail(
            "INVALID_ARGUMENT",
            `Component property ${requested} is a SLOT; use slot_append or slot_reset.`,
          );
        return [resolved, value];
      }),
    );
  }

  async function defaultPropertyValues(instance) {
    const main = await instance.getMainComponentAsync();
    let definitions = {};
    try {
      definitions = main?.componentPropertyDefinitions || {};
    } catch {
      if (main?.parent?.type === "COMPONENT_SET")
        definitions = main.parent.componentPropertyDefinitions || {};
    }
    const current = Object.keys(instance.componentProperties || {});
    return Object.fromEntries(
      current.flatMap((key) => {
        let definition = definitions[key];
        if (!definition) {
          const matches = Object.entries(definitions).filter(
            ([candidate]) => candidate.split("#")[0] === key.split("#")[0],
          );
          if (matches.length > 1)
            fail(
              "INVALID_ARGUMENT",
              `Component property default for ${key} is ambiguous.`,
              false,
              { key, matches: matches.map(([candidate]) => candidate) },
            );
          definition = matches[0]?.[1];
        }
        return definition &&
          definition.type !== "SLOT" &&
          definition.defaultValue !== undefined
          ? [[key, definition.defaultValue]]
          : [];
      }),
    );
  }

  async function serializeInstances(instances) {
    return Promise.all(instances.map((node) => serializeNode(node, true)));
  }

  async function instanceCommand(input) {
    if (input.action === "inspect") {
      const instances = await requireInstances(input.instanceIds);
      return { instances: await serializeInstances(instances) };
    }
    if (input.dryRun) return { dryRun: true, action: input.action };
    if (input.action === "create") {
      const component = await resolveComponent(input);
      const parent = await nodeById(input.parentId);
      if (!hasChildren(parent))
        fail("INVALID_ARGUMENT", "Instance parent cannot contain children.");
      const instance = component.createInstance();
      try {
        const properties = input.properties
          ? resolvePropertyPatch(instance, input.properties)
          : undefined;
        parent.appendChild(instance);
        if (input.x !== undefined) instance.x = input.x;
        if (input.y !== undefined) instance.y = input.y;
        if (properties) instance.setProperties(properties);
      } catch (error) {
        if (instance.parent) instance.remove();
        throw error;
      }
      recordChange("instance.create", [instance.id]);
      return { instances: [await serializeNode(instance, true)] };
    }

    if (input.action === "slot_append" || input.action === "slot_reset") {
      const [instance] = await requireInstances([input.instanceId]);
      const slot = slotIn(instance, input.slotName);
      if (!slot)
        fail(
          "SLOT_NOT_FOUND",
          `Instance ${instance.id} has no SLOT named ${input.slotName}.`,
        );
      if (input.action === "slot_append") {
        const component = await resolveComponent({
          componentKey: input.componentKey,
        });
        const appended = component.createInstance();
        try {
          slot.appendChild(appended);
        } catch (error) {
          if (appended.parent) appended.remove();
          throw error;
        }
      } else {
        try {
          slot.resetSlot();
        } catch {
          fail(
            "UNKNOWN_OUTCOME",
            "Slot reset failed after dispatch; removed slot children cannot be reconstructed safely.",
            false,
            { instanceId: instance.id, slotId: slot.id },
          );
        }
      }
      recordChange(`instance.${input.action}`, [instance.id, slot.id]);
      return {
        instances: [await serializeNode(instance, true)],
        slot: {
          id: slot.id,
          type: slot.type,
          name: slot.name,
          childCount: slot.children.length,
          limitViolations: [...(slot.limitViolations || [])],
        },
      };
    }

    const instances = await requireInstances(input.instanceIds);
    if (input.action === "swap") {
      const component = await resolveComponent(input);
      let completedCount = 0;
      try {
        for (const instance of instances) {
          if (input.preserveOverrides === false)
            instance.mainComponent = component;
          else instance.swapComponent(component);
          completedCount += 1;
        }
      } catch {
        fail(
          "UNKNOWN_OUTCOME",
          "Instance swap failed after dispatch; visual and nested overrides cannot be rolled back safely.",
          false,
          {
            completedCount,
            attemptedIndex: completedCount,
            total: instances.length,
          },
        );
      }
    } else if (input.action === "update") {
      const patches = instances.map((instance) =>
        resolvePropertyPatch(instance, input.properties),
      );
      const snapshots = instances.map((instance) => ({
        instance,
        properties: propertyValues(instance),
      }));
      try {
        for (const [index, instance] of instances.entries())
          instance.setProperties(patches[index]);
      } catch (error) {
        try {
          for (const snapshot of snapshots)
            snapshot.instance.setProperties(snapshot.properties);
        } catch {
          fail(
            "UNKNOWN_OUTCOME",
            "Instance property update failed and rollback was incomplete.",
          );
        }
        throw error;
      }
    } else if (input.action === "reset") {
      const defaults = await Promise.all(instances.map(defaultPropertyValues));
      let completedCount = 0;
      try {
        for (const [index, instance] of instances.entries()) {
          if (typeof instance.removeOverrides === "function")
            instance.removeOverrides();
          else instance.resetOverrides();
          instance.setProperties(defaults[index]);
          completedCount += 1;
        }
      } catch {
        fail(
          "UNKNOWN_OUTCOME",
          "Instance reset failed after dispatch; removed visual and nested overrides cannot be reconstructed safely.",
          false,
          {
            completedCount,
            attemptedIndex: completedCount,
            total: instances.length,
          },
        );
      }
    }
    recordChange(`instance.${input.action}`, input.instanceIds);
    return { instances: await serializeInstances(instances) };
  }
  return { command: instanceCommand };
}
