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
  async function localComponents() {
    await figma.loadAllPagesAsync();
    return figma.root.findAllWithCriteria({ types: ["COMPONENT"] });
  }

  /** @param {ComponentNode} node */
  function componentRecord(node) {
    return {
      source: "local",
      name: node.name,
      nodeId: node.id,
      key: node.key,
      description: node.description,
      properties: node.componentPropertyDefinitions,
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
      if (node?.type !== "COMPONENT")
        fail("NODE_NOT_FOUND", "Component was not found.");
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
        "UNSUPPORTED_BY_BRIDGE",
        "Library search requires a configured library inventory.",
      );
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
      const combinations = entries.reduce(
        (sets, [axis, values]) =>
          sets.flatMap((set) =>
            values.map((value) => ({ ...set, [axis]: value })),
          ),
        [{}],
      );
      const variants = combinations.map((combination) => {
        const component = figma.createComponent();
        component.name = Object.entries(combination)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ");
        parent.appendChild(component);
        return component;
      });
      const set = figma.combineAsVariants(variants, parent);
      set.name = input.name;
      recordChange("component.create_set", [set.id]);
      return { componentSet: await serializeNode(set, true) };
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
    if (component.type !== "COMPONENT")
      fail("INVALID_ARGUMENT", "Target is not a component.");
    if (input.action === "set_description")
      component.description = input.description;
    if (
      input.action === "property_add" &&
      input.property.options &&
      input.property.type !== "INSTANCE_SWAP"
    )
      fail(
        "UNSUPPORTED_BY_BRIDGE",
        "Figma derives VARIANT options from component-set variants; explicit options are only supported for INSTANCE_SWAP.",
      );
    if (input.action === "property_add")
      component.addComponentProperty(
        input.propertyName,
        input.property.type,
        input.property.defaultValue,
        input.property.options
          ? {
              preferredValues: input.property.options.map((key) => ({
                type: "COMPONENT",
                key,
              })),
            }
          : undefined,
      );
    if (input.action === "property_update")
      component.editComponentProperty(input.propertyName, input.patch);
    if (input.action === "property_delete")
      component.deleteComponentProperty(input.propertyName);
    if (input.action === "slots")
      return {
        slots: JSON.parse(component.getPluginData("mcp-fig-slots") || "{}"),
      };
    if (input.action === "slot_create") {
      const slots = JSON.parse(
        component.getPluginData("mcp-fig-slots") || "{}",
      );
      slots[input.slotName] = input.allowedComponentKeys || [];
      component.setPluginData("mcp-fig-slots", JSON.stringify(slots));
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
    if (input.componentKey)
      return figma.importComponentByKeyAsync(input.componentKey);
    fail("INVALID_ARGUMENT", "componentId or componentKey is required.");
  }
  return { command: componentCommand, resolveComponent };
}
