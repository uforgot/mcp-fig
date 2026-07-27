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
  const exportFormats = ["PNG", "JPG", "SVG", "PDF"];
  const exportMimeTypes = {
    PNG: "image/png",
    JPG: "image/jpeg",
    SVG: "image/svg+xml",
    PDF: "application/pdf",
  };
  const maxExportBytes = 650_000;

  async function queryNodes(input) {
    const maxDepth = input.maxDepth ?? 8;
    const limit = input.limit ?? 50;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20)
      fail(
        "INVALID_ARGUMENT",
        "node.query maxDepth must be an integer from 0 to 20.",
      );
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail(
        "INVALID_ARGUMENT",
        "node.query limit must be an integer from 1 to 100.",
      );
    if (
      input.name === undefined &&
      input.nodeType === undefined &&
      input.path === undefined
    )
      fail("INVALID_ARGUMENT", "node.query requires name, nodeType, or path.");
    if (
      input.path !== undefined &&
      (!Array.isArray(input.path) ||
        input.path.length < 1 ||
        input.path.length > 20 ||
        input.path.some((segment) => typeof segment !== "string" || !segment))
    )
      fail(
        "INVALID_ARGUMENT",
        "node.query path must contain 1 to 20 non-empty segments.",
      );

    const root = input.rootId ? await nodeById(input.rootId) : figma.root;
    if (root.type === "DOCUMENT") await figma.loadAllPagesAsync();
    const caseSensitive = input.caseSensitive ?? true;
    const nameMatch = input.nameMatch ?? "exact";
    const normalize = (value) =>
      caseSensitive ? value : value.toLocaleLowerCase("en-US");
    const expectedName =
      input.name === undefined ? undefined : normalize(input.name);
    const samePath = (actual) =>
      input.path === undefined ||
      (actual.length === input.path.length &&
        actual.every(
          (segment, index) =>
            normalize(segment) === normalize(input.path[index]),
        ));
    const matches = [];
    let truncated = false;

    const visit = async (node, path, depth) => {
      if (depth > maxDepth) return false;
      countSceneTraversal();
      const actualName = normalize(node.name);
      const matchesName =
        expectedName === undefined ||
        (nameMatch === "contains"
          ? actualName.includes(expectedName)
          : actualName === expectedName);
      if (
        matchesName &&
        (input.nodeType === undefined || node.type === input.nodeType) &&
        samePath(path)
      ) {
        if (matches.length === limit) {
          truncated = true;
          return true;
        }
        matches.push({
          node: await serializeNode(node, false, false),
          path: [...path],
        });
      }
      if (depth === maxDepth || !hasChildren(node)) return false;
      for (const child of node.children) {
        if (await visit(child, [...path, child.name], depth + 1)) return true;
      }
      return false;
    };

    if (hasChildren(root)) {
      for (const child of root.children) {
        if (await visit(child, [child.name], 1)) break;
      }
    }
    return { matches, limit, truncated };
  }

  function snapshotValue(value) {
    return typeof value === "symbol" ? value : cloneData(value);
  }

  function capturePatchState(node, patch) {
    const state = {};
    for (const key of Object.keys(patch)) {
      if (key === "width" || key === "height") continue;
      const property = key === "text" ? "characters" : key;
      if (property in node) state[property] = snapshotValue(node[property]);
    }
    if (
      (patch.width !== undefined || patch.height !== undefined) &&
      "resize" in node
    )
      state.size = { width: node.width, height: node.height };
    return state;
  }

  async function restorePatchState(node, state) {
    if (
      node.type === "TEXT" &&
      state.fontName &&
      typeof state.fontName !== "symbol"
    )
      await figma.loadFontAsync(state.fontName);
    if (state.size && "resize" in node)
      node.resize(state.size.width, state.size.height);
    for (const [key, value] of Object.entries(state)) {
      if (key !== "size") node[key] = snapshotValue(value);
    }
  }

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
    if (method === "node.query") return queryNodes(input);
    if (method === "node.get") {
      assertNodeIds(input.nodeIds);
      return Promise.all(
        input.nodeIds.map(async (id) => serializeNode(await nodeById(id))),
      );
    }
    if (method === "node.export") {
      assertNodeIds(input.nodeIds);
      const format = input.format;
      if (!exportFormats.includes(format))
        fail("INVALID_ARGUMENT", `Unsupported export format ${format}.`);
      const raster = format === "PNG" || format === "JPG";
      if (
        raster &&
        (typeof input.scale !== "number" ||
          !Number.isFinite(input.scale) ||
          input.scale <= 0 ||
          input.scale > 4)
      )
        fail(
          "INVALID_ARGUMENT",
          "Raster export scale must be greater than 0 and at most 4.",
        );
      if (!raster && input.scale !== undefined)
        fail("INVALID_ARGUMENT", `${format} export does not accept scale.`);

      const nodes = await Promise.all(input.nodeIds.map(nodeById));
      const settings = raster
        ? {
            format,
            constraint: { type: "SCALE", value: input.scale },
          }
        : { format };
      const results = [];
      for (const node of nodes) {
        if (typeof node.exportAsync !== "function")
          fail("UNSUPPORTED_BY_BRIDGE", `Node ${node.id} cannot be exported.`);
        const bytes = await node.exportAsync(settings);
        if (bytes.byteLength > maxExportBytes) {
          const recovery = raster
            ? "lower the scale"
            : `reduce the source complexity or export ${format} content as PNG/JPG`;
          fail(
            "INVALID_ARGUMENT",
            `Export for node ${node.id} is ${bytes.byteLength} bytes; ${recovery} to stay at or below ${maxExportBytes} bytes.`,
          );
        }
        results.push({
          nodeId: node.id,
          nodeName: node.name,
          format,
          mimeType: exportMimeTypes[format],
          byteLength: bytes.byteLength,
          dataBase64: figma.base64Encode(bytes),
        });
      }
      return results;
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
      const snapshots = new Map(
        nodes.map((node) => [node.id, capturePatchState(node, input.patch)]),
      );
      try {
        for (const node of nodes) await applyProps(node, input.patch);
      } catch (error) {
        const rollback = await Promise.allSettled(
          nodes.map((node) => restorePatchState(node, snapshots.get(node.id))),
        );
        if (rollback.some((result) => result.status === "rejected"))
          fail(
            "UNKNOWN_OUTCOME",
            "Node update failed and rollback could not restore every node.",
          );
        throw error;
      }
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
