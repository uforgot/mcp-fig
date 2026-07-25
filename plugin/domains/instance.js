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
  async function instanceCommand(input) {
    if (input.dryRun) return { dryRun: true, action: input.action };
    if (input.action === "create") {
      const component = await resolveComponent(input);
      const parent = await nodeById(input.parentId);
      if (!hasChildren(parent))
        fail("INVALID_ARGUMENT", "Instance parent cannot contain children.");
      const instance = component.createInstance();
      parent.appendChild(instance);
      if (input.x !== undefined) instance.x = input.x;
      if (input.y !== undefined) instance.y = input.y;
      if (input.properties) instance.setProperties(input.properties);
      recordChange("instance.create", [instance.id]);
      return { instances: [await serializeNode(instance, true)] };
    }
    const ids = input.instanceIds || [input.instanceId];
    assertNodeIds(ids);
    const instances = await Promise.all(
      ids.map(async (id) => {
        const node = await nodeById(id);
        if (node.type !== "INSTANCE")
          fail("INVALID_ARGUMENT", "Every target must be an instance.");
        return node;
      }),
    );
    if (input.action === "update")
      instances.forEach((instance) => {
        instance.setProperties(input.properties);
      });
    if (input.action === "slot_reset")
      instances.forEach((instance) => {
        instance.resetOverrides();
      });
    if (input.action === "slot_append")
      fail(
        "UNSUPPORTED_BY_BRIDGE",
        "Slot append needs a concrete slot node mapping.",
      );
    recordChange(`instance.${input.action}`, ids);
    return {
      instances: await Promise.all(
        instances.map((node) => serializeNode(node, true)),
      ),
    };
  }
  return { command: instanceCommand };
}
