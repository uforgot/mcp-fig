// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createLayoutDomain({
  fail,
  assertNodeIds,
  cloneData,
  countSceneTraversal,
  recordChange,
  nodeById,
  hasChildren,
  parentId,
}) {
  function padding(layout) {
    if (typeof layout.padding === "number") {
      return {
        top: layout.padding,
        right: layout.padding,
        bottom: layout.padding,
        left: layout.padding,
      };
    }
    return layout.padding;
  }

  function applyLayout(node, layout) {
    if (!("layoutMode" in node))
      fail("INVALID_ARGUMENT", `Node ${node.id} does not support Auto Layout.`);
    node.layoutMode = layout.layoutMode;
    if (layout.gap !== undefined || layout.itemSpacing !== undefined)
      node.itemSpacing = layout.gap ?? layout.itemSpacing;
    const pad = padding(layout);
    if (pad) {
      node.paddingTop = pad.top;
      node.paddingRight = pad.right;
      node.paddingBottom = pad.bottom;
      node.paddingLeft = pad.left;
    }
    for (const key of [
      "primaryAxisAlignItems",
      "counterAxisAlignItems",
      "layoutWrap",
      "primaryAxisSizingMode",
      "counterAxisSizingMode",
    ])
      if (layout[key] !== undefined) node[key] = layout[key];
  }

  function applySizing(node, sizing) {
    if (!("layoutSizingHorizontal" in node))
      fail(
        "INVALID_ARGUMENT",
        `Node ${node.id} does not support layout sizing.`,
      );
    node.layoutSizingHorizontal = sizing.horizontal;
    node.layoutSizingVertical = sizing.vertical;
    for (const key of [
      "minWidth",
      "maxWidth",
      "minHeight",
      "maxHeight",
      "layoutAlign",
    ]) {
      if (sizing[key] !== undefined) node[key] = sizing[key];
    }
  }

  function layoutSnapshot(node) {
    const parent = parentId(node);
    return {
      nodeId: node.id,
      name: node.name,
      ...(parent ? { parentId: parent } : {}),
      childIds: hasChildren(node) ? node.children.map((child) => child.id) : [],
      layout: {
        layoutMode: "layoutMode" in node ? node.layoutMode : "NONE",
        gap: "itemSpacing" in node ? (node.itemSpacing ?? 0) : 0,
        itemSpacing: "itemSpacing" in node ? (node.itemSpacing ?? 0) : 0,
        padding: {
          top: "paddingTop" in node ? (node.paddingTop ?? 0) : 0,
          right: "paddingRight" in node ? (node.paddingRight ?? 0) : 0,
          bottom: "paddingBottom" in node ? (node.paddingBottom ?? 0) : 0,
          left: "paddingLeft" in node ? (node.paddingLeft ?? 0) : 0,
        },
        primaryAxisAlignItems:
          "primaryAxisAlignItems" in node
            ? (node.primaryAxisAlignItems ?? "MIN")
            : "MIN",
        counterAxisAlignItems:
          "counterAxisAlignItems" in node
            ? (node.counterAxisAlignItems ?? "MIN")
            : "MIN",
        layoutWrap:
          "layoutWrap" in node ? (node.layoutWrap ?? "NO_WRAP") : "NO_WRAP",
        primaryAxisSizingMode:
          "primaryAxisSizingMode" in node
            ? (node.primaryAxisSizingMode ?? "FIXED")
            : "FIXED",
        counterAxisSizingMode:
          "counterAxisSizingMode" in node
            ? (node.counterAxisSizingMode ?? "FIXED")
            : "FIXED",
      },
      sizing: {
        horizontal:
          "layoutSizingHorizontal" in node
            ? (node.layoutSizingHorizontal ?? "FIXED")
            : "FIXED",
        vertical:
          "layoutSizingVertical" in node
            ? (node.layoutSizingVertical ?? "FIXED")
            : "FIXED",
        ...(node.minWidth !== undefined ? { minWidth: node.minWidth } : {}),
        ...(node.maxWidth !== undefined ? { maxWidth: node.maxWidth } : {}),
        ...(node.minHeight !== undefined ? { minHeight: node.minHeight } : {}),
        ...(node.maxHeight !== undefined ? { maxHeight: node.maxHeight } : {}),
        ...(node.layoutAlign !== undefined
          ? { layoutAlign: node.layoutAlign }
          : {}),
        ...(node.layoutPositioning !== undefined
          ? { layoutPositioning: node.layoutPositioning }
          : {}),
      },
      constraints:
        "constraints" in node
          ? node.constraints
          : { horizontal: "LEFT", vertical: "TOP" },
    };
  }

  /**
   * @param {BaseNode} node
   * @returns {node is FrameNode | ComponentNode | ComponentSetNode | InstanceNode}
   */
  function isAutoLayoutContainer(node) {
    return ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(
      node.type,
    );
  }

  function parentAxisSizing(node, axis) {
    const primary =
      (node.layoutMode === "HORIZONTAL" && axis === "horizontal") ||
      (node.layoutMode === "VERTICAL" && axis === "vertical");
    return primary
      ? (node.primaryAxisSizingMode ?? "FIXED")
      : (node.counterAxisSizingMode ?? "FIXED");
  }

  function childExtent(node, axis) {
    const sizing =
      axis === "horizontal"
        ? node.layoutSizingHorizontal
        : node.layoutSizingVertical;
    const minimum = axis === "horizontal" ? node.minWidth : node.minHeight;
    if (sizing === "FILL") return minimum ?? 0;
    return (axis === "horizontal" ? node.width : node.height) ?? minimum ?? 0;
  }

  function validateNode(node) {
    const issues = [];
    const parent = node.parent;
    const parentAuto =
      parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
    if (
      "layoutSizingHorizontal" in node &&
      node.layoutPositioning !== "ABSOLUTE"
    ) {
      for (const axis of ["horizontal", "vertical"]) {
        const property =
          axis === "horizontal"
            ? "layoutSizingHorizontal"
            : "layoutSizingVertical";
        const sizing = node[property];
        if (sizing !== "HUG" && sizing !== "FILL") continue;
        if (!parentAuto) {
          issues.push({
            code:
              sizing === "HUG"
                ? "HUG_WITHOUT_AUTO_LAYOUT_PARENT"
                : "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
            nodeId: node.id,
            axis,
            repairable: true,
            message: `${sizing} requires an Auto Layout parent.`,
            details: { property, parentId: parent?.id, current: sizing },
          });
        } else if (
          sizing === "FILL" &&
          parentAxisSizing(parent, axis) === "AUTO"
        ) {
          issues.push({
            code:
              axis === "horizontal"
                ? "FILL_IN_HUG_PARENT_HORIZONTAL"
                : "FILL_IN_HUG_PARENT_VERTICAL",
            nodeId: node.id,
            axis,
            repairable: true,
            message: `FILL on ${axis} conflicts with a hugging parent.`,
            details: { property, parentId: parent.id, current: sizing },
          });
        }
      }
    }
    if (
      "minWidth" in node &&
      node.minWidth != null &&
      node.maxWidth != null &&
      node.minWidth > node.maxWidth
    ) {
      issues.push({
        code: "MIN_MAX_CONFLICT_WIDTH",
        nodeId: node.id,
        axis: "horizontal",
        repairable: false,
        message: "minWidth is greater than maxWidth.",
        details: { minimum: node.minWidth, maximum: node.maxWidth },
      });
    }
    if (
      "minHeight" in node &&
      node.minHeight != null &&
      node.maxHeight != null &&
      node.minHeight > node.maxHeight
    ) {
      issues.push({
        code: "MIN_MAX_CONFLICT_HEIGHT",
        nodeId: node.id,
        axis: "vertical",
        repairable: false,
        message: "minHeight is greater than maxHeight.",
        details: { minimum: node.minHeight, maximum: node.maxHeight },
      });
    }
    if (
      isAutoLayoutContainer(node) &&
      node.layoutMode !== "NONE" &&
      node.layoutWrap !== "WRAP" &&
      hasChildren(node)
    ) {
      const children = node.children.filter(
        (child) =>
          child.visible !== false &&
          (!("layoutPositioning" in child) ||
            child.layoutPositioning !== "ABSOLUTE"),
      );
      if (children.length > 0) {
        const gap = node.itemSpacing ?? 0;
        const horizontal = node.layoutMode === "HORIZONTAL";
        const requiredHorizontal =
          node.paddingLeft +
          node.paddingRight +
          (horizontal
            ? children.reduce(
                (sum, child) => sum + childExtent(child, "horizontal"),
                0,
              ) +
              gap * Math.max(0, children.length - 1)
            : Math.max(
                ...children.map((child) => childExtent(child, "horizontal")),
              ));
        const requiredVertical =
          node.paddingTop +
          node.paddingBottom +
          (horizontal
            ? Math.max(
                ...children.map((child) => childExtent(child, "vertical")),
              )
            : children.reduce(
                (sum, child) => sum + childExtent(child, "vertical"),
                0,
              ) +
              gap * Math.max(0, children.length - 1));
        for (const [axis, required, available] of [
          ["horizontal", requiredHorizontal, node.width],
          ["vertical", requiredVertical, node.height],
        ]) {
          if (
            parentAxisSizing(node, axis) === "FIXED" &&
            required > available
          ) {
            issues.push({
              code:
                axis === "horizontal"
                  ? "AUTO_LAYOUT_OVERFLOW_HORIZONTAL"
                  : "AUTO_LAYOUT_OVERFLOW_VERTICAL",
              nodeId: node.id,
              axis,
              repairable: false,
              message: `Auto Layout node overflows its ${axis} bounds.`,
              details: {
                required,
                available,
                overflowBy: required - available,
              },
            });
          }
        }
      }
    }
    return issues;
  }

  function collectLayoutScope(nodes) {
    const result = [];
    const visited = new Set();
    const visit = (node) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      countSceneTraversal();
      result.push(node);
      if (hasChildren(node)) node.children.forEach(visit);
    };
    nodes.forEach(visit);
    return result;
  }

  function validateLayoutScope(nodes) {
    const issues = collectLayoutScope(nodes).flatMap(validateNode);
    return { valid: issues.length === 0, issues };
  }

  function assertLayoutOperation(node, operation, plannedAutoLayoutParents) {
    if (operation.op === "apply" && !("layoutMode" in node))
      fail("INVALID_ARGUMENT", `Node ${node.id} does not support Auto Layout.`);
    if (operation.op === "sizing") {
      if (!("layoutSizingHorizontal" in node))
        fail(
          "INVALID_ARGUMENT",
          `Node ${node.id} does not support layout sizing.`,
        );
      const automatic =
        operation.sizing.horizontal !== "FIXED" ||
        operation.sizing.vertical !== "FIXED";
      const parent = node.parent;
      if (
        automatic &&
        (!parent ||
          ((!("layoutMode" in parent) || parent.layoutMode === "NONE") &&
            !plannedAutoLayoutParents.has(parent.id)))
      )
        fail(
          "INVALID_ARGUMENT",
          `Node ${node.id} requires an Auto Layout parent for HUG or FILL sizing.`,
        );
      const minWidth = operation.sizing.minWidth ?? node.minWidth;
      const maxWidth = operation.sizing.maxWidth ?? node.maxWidth;
      const minHeight = operation.sizing.minHeight ?? node.minHeight;
      const maxHeight = operation.sizing.maxHeight ?? node.maxHeight;
      if (minWidth != null && maxWidth != null && minWidth > maxWidth)
        fail("INVALID_ARGUMENT", "minWidth must not exceed maxWidth.");
      if (minHeight != null && maxHeight != null && minHeight > maxHeight)
        fail("INVALID_ARGUMENT", "minHeight must not exceed maxHeight.");
    }
    if (operation.op === "constraints" && !("constraints" in node))
      fail("INVALID_ARGUMENT", `Node ${node.id} does not support constraints.`);
  }

  function nodeDepth(node) {
    let depth = 0;
    let current = node.parent;
    while (current) {
      depth += 1;
      current = current.parent;
    }
    return depth;
  }

  function applyLayoutPreview(snapshot, layout) {
    snapshot.layout.layoutMode = layout.layoutMode;
    const gap = layout.gap ?? layout.itemSpacing;
    if (gap !== undefined) {
      snapshot.layout.gap = gap;
      snapshot.layout.itemSpacing = gap;
    }
    const pad = padding(layout);
    if (pad) snapshot.layout.padding = { ...pad };
    for (const key of [
      "primaryAxisAlignItems",
      "counterAxisAlignItems",
      "layoutWrap",
      "primaryAxisSizingMode",
      "counterAxisSizingMode",
    ])
      if (layout[key] !== undefined) snapshot.layout[key] = layout[key];
  }

  function applySizingPreview(snapshot, sizing) {
    snapshot.sizing.horizontal = sizing.horizontal;
    snapshot.sizing.vertical = sizing.vertical;
    for (const key of [
      "minWidth",
      "maxWidth",
      "minHeight",
      "maxHeight",
      "layoutAlign",
    ])
      if (sizing[key] !== undefined) snapshot.sizing[key] = sizing[key];
  }

  function captureLayoutState(node) {
    const state = {};
    for (const key of [
      "layoutMode",
      "itemSpacing",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "primaryAxisAlignItems",
      "counterAxisAlignItems",
      "layoutWrap",
      "primaryAxisSizingMode",
      "counterAxisSizingMode",
      "layoutSizingHorizontal",
      "layoutSizingVertical",
      "minWidth",
      "maxWidth",
      "minHeight",
      "maxHeight",
      "layoutAlign",
      "constraints",
    ])
      if (key in node) state[key] = cloneData(node[key]);
    return state;
  }

  function restoreLayoutState(node, state) {
    for (const [key, value] of Object.entries(state)) node[key] = value;
  }

  async function layoutCommand(input) {
    if (input.action !== "batch") assertNodeIds(input.nodeIds);
    const directNodes =
      input.action === "batch"
        ? []
        : await Promise.all(input.nodeIds.map(nodeById));
    if (input.action === "inspect")
      return { layouts: await Promise.all(directNodes.map(layoutSnapshot)) };
    if (input.action === "validate") return validateLayoutScope(directNodes);
    if (input.action === "repair") {
      const repairableCodes = new Set([
        "FILL_IN_HUG_PARENT_HORIZONTAL",
        "FILL_IN_HUG_PARENT_VERTICAL",
        "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
        "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
      ]);
      const unsafeCodes = [...new Set(input.issueCodes)].filter(
        (code) => !repairableCodes.has(code),
      );
      if (unsafeCodes.length)
        fail(
          "INVALID_ARGUMENT",
          "Requested layout repair includes unsafe issue codes.",
          false,
          { issueCodes: unsafeCodes },
        );
      const beforeValidation = validateLayoutScope(directNodes);
      const selected = beforeValidation.issues.filter((issue) =>
        input.issueCodes.includes(issue.code),
      );
      const repairs = selected.map((issue) => ({
        issueCode: issue.code,
        nodeId: issue.nodeId,
        reason: issue.message,
        changes: [
          {
            property: issue.details.property,
            from: issue.details.current,
            to: "FIXED",
          },
        ],
      }));
      if (input.dryRun) {
        const selectedKeys = new Set(
          selected.map(
            (issue) => `${issue.code}:${issue.nodeId}:${issue.axis}`,
          ),
        );
        const issues = beforeValidation.issues.filter(
          (issue) =>
            !selectedKeys.has(`${issue.code}:${issue.nodeId}:${issue.axis}`),
        );
        return {
          beforeValidation,
          repairs,
          afterValidation: { valid: issues.length === 0, issues },
          dryRun: true,
        };
      }

      const repairedNodeMap = new Map();
      for (const issue of selected) {
        const node = await nodeById(issue.nodeId);
        repairedNodeMap.set(node.id, node);
      }
      const repairedNodes = [...repairedNodeMap.values()];
      const originals = new Map(
        repairedNodes.map((node) => [node.id, captureLayoutState(node)]),
      );
      try {
        for (const issue of selected) {
          const node = await nodeById(issue.nodeId);
          node[issue.details.property] = "FIXED";
        }
        const afterValidation = validateLayoutScope(directNodes);
        const unresolved = afterValidation.issues.filter((issue) =>
          input.issueCodes.includes(issue.code),
        );
        if (repairs.length > 0 && unresolved.length > 0)
          fail(
            "INTERNAL_ERROR",
            "Auto Layout repair did not clear every selected issue.",
            false,
            { unresolvedIssues: unresolved },
          );
        if (repairs.length) recordChange("layout.repair", input.nodeIds);
        return {
          beforeValidation,
          repairs,
          afterValidation,
          dryRun: false,
        };
      } catch (error) {
        for (const node of repairedNodes) {
          const original = originals.get(node.id);
          if (original) restoreLayoutState(node, original);
        }
        throw error;
      }
    }

    const operations =
      input.action === "batch"
        ? input.operations
        : input.action === "apply"
          ? [{ op: "apply", nodeIds: input.nodeIds, layout: input.layout }]
          : [{ op: "sizing", nodeIds: input.nodeIds, sizing: input.sizing }];
    for (const operation of operations) assertNodeIds(operation.nodeIds);
    const units = [];
    const plannedAutoLayoutParents = new Set(
      operations
        .filter(
          (operation) =>
            operation.op === "apply" && operation.layout.layoutMode !== "NONE",
        )
        .flatMap((operation) => operation.nodeIds),
    );
    for (const [operationIndex, operation] of operations.entries()) {
      for (const [nodeIndex, nodeId] of operation.nodeIds.entries()) {
        const node = await nodeById(nodeId);
        assertLayoutOperation(node, operation, plannedAutoLayoutParents);
        units.push({ operation, operationIndex, nodeIndex, node });
      }
    }
    const phase = { apply: 0, sizing: 1, constraints: 2 };
    units.sort((left, right) => {
      const phaseDifference =
        phase[left.operation.op] - phase[right.operation.op];
      if (phaseDifference !== 0) return phaseDifference;
      const depthDifference = nodeDepth(left.node) - nodeDepth(right.node);
      if (depthDifference !== 0) return depthDifference;
      return (
        left.operationIndex - right.operationIndex ||
        left.nodeIndex - right.nodeIndex
      );
    });
    const targetNodes = [
      ...new Map(units.map((unit) => [unit.node.id, unit.node])).values(),
    ].sort(
      (left, right) =>
        nodeDepth(left) - nodeDepth(right) || left.id.localeCompare(right.id),
    );
    const targetIds = targetNodes.map((node) => node.id);
    const before = targetNodes.map(layoutSnapshot);
    const appliedOrder = units.map(
      (unit) => `${unit.operation.op}:${unit.node.id}`,
    );

    if (input.dryRun) {
      const previews = new Map(
        before.map((snapshot) => [snapshot.nodeId, cloneData(snapshot)]),
      );
      for (const { operation, node } of units) {
        const snapshot = previews.get(node.id);
        if (operation.op === "apply")
          applyLayoutPreview(snapshot, operation.layout);
        else if (operation.op === "sizing")
          applySizingPreview(snapshot, operation.sizing);
        else snapshot.constraints = { ...operation.constraints };
      }
      return {
        before,
        after: targetIds.map((nodeId) => previews.get(nodeId)),
        appliedOrder,
        dryRun: true,
      };
    }

    const originals = new Map(
      targetNodes.map((node) => [node.id, captureLayoutState(node)]),
    );
    try {
      for (const { operation, node } of units) {
        if (operation.op === "apply") applyLayout(node, operation.layout);
        else if (operation.op === "sizing") applySizing(node, operation.sizing);
        else if ("constraints" in node)
          node.constraints = operation.constraints;
      }
      const after = targetNodes.map(layoutSnapshot);
      recordChange(`layout.${input.action}`, targetIds);
      return { before, after, appliedOrder, dryRun: false };
    } catch (error) {
      for (const node of targetNodes) {
        const original = originals.get(node.id);
        if (original) restoreLayoutState(node, original);
      }
      throw error;
    }
  }
  return { command: layoutCommand };
}
