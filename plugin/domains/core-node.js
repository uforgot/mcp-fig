// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createCoreNodeDomain({
  figma,
  fail,
  assertNodeIds,
  cloneData,
  revisionCached,
  recordChange,
  getChanges,
  countSceneTraversal,
  nodeById,
  hasChildren,
  serializeNode,
  applyProps,
  validateProps,
  createByType,
}) {
  async function coreCommand(method, input) {
    if (method === "document.summary") {
      return revisionCached("document.summary", async () => {
        await figma.loadAllPagesAsync();
        const byType = {};
        let nodeCount = 0;
        const visit = (node) => {
          nodeCount += 1;
          countSceneTraversal();
          byType[node.type] = (byType[node.type] || 0) + 1;
          if (hasChildren(node)) node.children.forEach(visit);
        };
        visit(figma.root);
        return {
          document: {
            id: figma.root.id,
            name: figma.root.name,
            type: figma.root.type,
          },
          nodeCount,
          byType,
        };
      });
    }
    if (method === "document.get") {
      await figma.loadAllPagesAsync();
      return serializeNode(figma.root, true);
    }
    if (method === "selection.get")
      return figma.currentPage.selection.map((node) => node.id);
    if (method === "changes.get") return getChanges();
    if (method === "node.get") {
      assertNodeIds(input.nodeIds);
      return Promise.all(
        input.nodeIds.map(async (id) => serializeNode(await nodeById(id))),
      );
    }
    if (method === "node.create") {
      const parent = await nodeById(input.parentId);
      if (!hasChildren(parent) || typeof parent.appendChild !== "function") {
        fail(
          "INVALID_ARGUMENT",
          `Parent ${input.parentId} cannot contain children.`,
        );
      }
      if (input.dryRun) {
        return [
          {
            id: "preview:new",
            type: input.nodeType,
            name: input.name || input.nodeType,
            parentId: parent.id,
            ...input.props,
          },
        ];
      }
      const node = createByType(input.nodeType);
      try {
        await validateProps(node, input.props);
        parent.appendChild(node);
        if (input.name) node.name = input.name;
        await applyProps(node, input.props);
      } catch (error) {
        node.remove();
        throw error;
      }
      recordChange("create", [node.id]);
      return [await serializeNode(node)];
    }
    assertNodeIds(input.nodeIds);
    const nodes = await Promise.all(input.nodeIds.map(nodeById));
    if (input.dryRun) {
      if (method === "node.update") {
        await Promise.all(
          nodes.map((node) => validateProps(node, input.patch)),
        );
        return Promise.all(
          nodes.map(async (node) => ({
            ...(await serializeNode(node)),
            ...cloneData(input.patch),
          })),
        );
      }
      if (method === "node.move") {
        let parent;
        if (input.parentId) {
          parent = await nodeById(input.parentId);
          if (!hasChildren(parent) || typeof parent.insertChild !== "function")
            fail("INVALID_ARGUMENT", "Target parent cannot contain children.");
        }
        return Promise.all(
          nodes.map(async (node) => ({
            ...(await serializeNode(node)),
            ...(parent ? { parentId: parent.id } : {}),
            ...(input.x !== undefined ? { x: input.x } : {}),
            ...(input.y !== undefined ? { y: input.y } : {}),
          })),
        );
      }
      if (method === "node.resize") {
        for (const node of nodes)
          if (!("resize" in node))
            fail("INVALID_ARGUMENT", `Node ${node.id} cannot be resized.`);
        return Promise.all(
          nodes.map(async (node) => ({
            ...(await serializeNode(node)),
            width: input.size.width,
            height: input.size.height,
          })),
        );
      }
      if (method === "node.clone") {
        let parent;
        if (input.parentId) {
          parent = await nodeById(input.parentId);
          if (!hasChildren(parent) || typeof parent.appendChild !== "function")
            fail("INVALID_ARGUMENT", "Clone parent cannot contain children.");
        }
        return Promise.all(
          nodes.map(async (node) => {
            const snapshot = await serializeNode(node);
            return {
              ...snapshot,
              id: `preview:${node.id}`,
              ...(parent ? { parentId: parent.id } : {}),
              ...(input.offset && "x" in node
                ? { x: node.x + input.offset.x }
                : {}),
              ...(input.offset && "y" in node
                ? { y: node.y + input.offset.y }
                : {}),
            };
          }),
        );
      }
      if (method === "node.delete") return [...input.nodeIds];
    }
    if (method === "node.update") {
      await Promise.all(nodes.map((node) => validateProps(node, input.patch)));
      for (const node of nodes) await applyProps(node, input.patch);
      recordChange("update", input.nodeIds);
      return Promise.all(nodes.map((node) => serializeNode(node)));
    }
    if (method === "node.move") {
      let parent;
      if (input.parentId) {
        parent = await nodeById(input.parentId);
        if (!hasChildren(parent) || typeof parent.insertChild !== "function")
          fail("INVALID_ARGUMENT", "Target parent cannot contain children.");
      }
      for (const node of nodes) {
        if (input.x !== undefined && !("x" in node))
          fail("INVALID_ARGUMENT", `Node ${node.id} cannot be positioned.`);
        if (input.y !== undefined && !("y" in node))
          fail("INVALID_ARGUMENT", `Node ${node.id} cannot be positioned.`);
      }
      nodes.forEach((node, offset) => {
        if (parent)
          parent.insertChild(
            (input.index ?? parent.children.length) + offset,
            node,
          );
        if (input.x !== undefined && "x" in node) node.x = input.x;
        if (input.y !== undefined && "y" in node) node.y = input.y;
      });
      recordChange("move", input.nodeIds);
      return Promise.all(nodes.map((node) => serializeNode(node)));
    }
    if (method === "node.resize") {
      for (const node of nodes)
        if (!("resize" in node))
          fail("INVALID_ARGUMENT", `Node ${node.id} cannot be resized.`);
      for (const node of nodes) {
        node.resize(input.size.width, input.size.height);
      }
      recordChange("resize", input.nodeIds);
      return Promise.all(nodes.map((node) => serializeNode(node)));
    }
    if (method === "node.clone") {
      for (const node of nodes)
        if (!("clone" in node))
          fail("UNSUPPORTED_BY_BRIDGE", `Node ${node.id} cannot be cloned.`);
      let cloneParent;
      if (input.parentId) {
        cloneParent = await nodeById(input.parentId);
        if (
          !hasChildren(cloneParent) ||
          typeof cloneParent.appendChild !== "function"
        )
          fail("INVALID_ARGUMENT", "Clone parent cannot contain children.");
      }
      const clones = nodes.map((node) => ({ clone: node.clone() }));
      for (const entry of clones) {
        if (cloneParent) cloneParent.appendChild(entry.clone);
        if (input.offset && "x" in entry.clone) entry.clone.x += input.offset.x;
        if (input.offset && "y" in entry.clone) entry.clone.y += input.offset.y;
      }
      recordChange(
        "clone",
        clones.map((entry) => entry.clone.id),
      );
      return Promise.all(clones.map((entry) => serializeNode(entry.clone)));
    }
    if (method === "node.delete") {
      for (const node of nodes) node.remove();
      recordChange("delete", input.nodeIds);
      return input.nodeIds;
    }
    fail("UNSUPPORTED_BY_BRIDGE", `Unknown core method ${method}.`);
  }
  return { command: coreCommand };
}
