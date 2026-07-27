// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createVisualDomain({ figma, fail, nodeById }) {
  const categories = ["accessibility", "design_system", "layout", "lint"];
  let captureLease;

  function activeCaptureLease() {
    if (captureLease && captureLease.expiresAt <= Date.now())
      captureLease = undefined;
    return captureLease;
  }

  function captureBlocked(method, params = {}) {
    const lease = activeCaptureLease();
    if (!lease) return false;
    return !(
      method === "visual" &&
      params.action === "release_capture" &&
      params.leaseId === lease.id
    );
  }

  function releaseCapture(input) {
    const lease = activeCaptureLease();
    if (!lease || input.leaseId !== lease.id)
      fail(
        "INVALID_ARGUMENT",
        "Capture lease is missing, expired, or does not match.",
      );
    captureLease = undefined;
    return { released: true, leaseId: input.leaseId };
  }

  function finiteBounds(value) {
    if (
      !value ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      typeof value.width !== "number" ||
      typeof value.height !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height)
    )
      return undefined;
    return {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    };
  }

  function nodeBounds(node) {
    return (
      finiteBounds(node.absoluteRenderBounds) ||
      finiteBounds(node.absoluteBoundingBox)
    );
  }

  function layoutBounds(node) {
    return (
      finiteBounds(node.absoluteBoundingBox) ||
      finiteBounds(node.absoluteRenderBounds)
    );
  }

  function unionBounds(nodes) {
    const bounds = nodes.map(nodeBounds).filter(Boolean);
    if (bounds.length === 0) return undefined;
    const left = Math.min(...bounds.map((box) => box.x));
    const top = Math.min(...bounds.map((box) => box.y));
    const right = Math.max(...bounds.map((box) => box.x + box.width));
    const bottom = Math.max(...bounds.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function intersects(left, right) {
    return (
      left.x < right.x + right.width &&
      left.x + left.width > right.x &&
      left.y < right.y + right.height &&
      left.y + left.height > right.y
    );
  }

  function exceeds(child, parent) {
    const epsilon = 0.01;
    return (
      child.x < parent.x - epsilon ||
      child.y < parent.y - epsilon ||
      child.x + child.width > parent.x + parent.width + epsilon ||
      child.y + child.height > parent.y + parent.height + epsilon
    );
  }

  function solidPaint(node) {
    if (!Array.isArray(node?.fills)) return undefined;
    return node.fills.find(
      (paint) =>
        paint &&
        paint.type === "SOLID" &&
        paint.visible !== false &&
        paint.color &&
        typeof paint.color.r === "number" &&
        typeof paint.color.g === "number" &&
        typeof paint.color.b === "number",
    );
  }

  function opaqueNode(node) {
    const opacity = typeof node?.opacity === "number" ? node.opacity : 1;
    const rotation = typeof node?.rotation === "number" ? node.rotation : 0;
    const blendMode = String(node?.blendMode || "PASS_THROUGH");
    const visibleEffects = Array.isArray(node?.effects)
      ? node.effects.filter((effect) => effect?.visible !== false)
      : [];
    return (
      opacity === 1 &&
      rotation === 0 &&
      ["NORMAL", "PASS_THROUGH"].includes(blendMode) &&
      visibleEffects.length === 0
    );
  }

  function opaqueSolidPaint(node) {
    if (!opaqueNode(node) || !Array.isArray(node?.fills)) return undefined;
    const visible = node.fills.filter((paint) => paint?.visible !== false);
    if (visible.length !== 1) return undefined;
    const paint = visible[0];
    if (
      paint.type !== "SOLID" ||
      (typeof paint.opacity === "number" ? paint.opacity : 1) !== 1 ||
      !["NORMAL", undefined].includes(paint.blendMode) ||
      !paint.color ||
      typeof paint.color.r !== "number" ||
      typeof paint.color.g !== "number" ||
      typeof paint.color.b !== "number"
    )
      return undefined;
    return paint;
  }

  function relativeLuminance(color) {
    const channel = (value) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return (
      0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b)
    );
  }

  function contrastRatio(foreground, background) {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function hasOverlappingSibling(node) {
    const bounds = nodeBounds(node);
    if (!bounds || !Array.isArray(node.parent?.children)) return true;
    return node.parent.children.some((sibling) => {
      if (sibling.id === node.id || sibling.visible === false) return false;
      const siblingBounds = nodeBounds(sibling);
      return Boolean(siblingBounds && intersects(bounds, siblingBounds));
    });
  }

  function backgroundPaint(node) {
    const parent = node.parent;
    if (!parent || parent.type === "DOCUMENT") return undefined;
    const bounds = nodeBounds(node);
    const parentBounds = nodeBounds(parent);
    if (!bounds || !parentBounds || exceeds(bounds, parentBounds))
      return undefined;
    if (hasOverlappingSibling(node)) return undefined;
    const background = opaqueSolidPaint(parent);
    if (!background) return undefined;
    let current = parent;
    while (current && !["DOCUMENT", "PAGE"].includes(current.type)) {
      if (!opaqueNode(current) || hasOverlappingSibling(current))
        return undefined;
      current = current.parent;
    }
    return background;
  }

  function fontSize(node) {
    return typeof node.fontSize === "number" && Number.isFinite(node.fontSize)
      ? node.fontSize
      : undefined;
  }

  function boundColor(node, paint) {
    return Boolean(
      paint?.boundVariables?.color ||
        node.boundVariables?.fills ||
        node.boundVariables?.strokes,
    );
  }

  function issueSummary(issues) {
    const byCategory = {};
    const bySeverity = {};
    for (const issue of issues) {
      byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    }
    return { byCategory, bySeverity };
  }

  async function prepareCapture(input) {
    if (activeCaptureLease())
      fail(
        "BUSY",
        "A Desktop screenshot capture is already in progress.",
        true,
      );
    const lease = {
      id: `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      expiresAt: Date.now() + 15_000,
    };
    captureLease = lease;
    try {
      const scope = input.scope;
      if (!["viewport", "selection", "node"].includes(scope))
        fail("INVALID_ARGUMENT", `Unsupported screenshot scope ${scope}.`);
      if (
        scope === "node" &&
        (!Array.isArray(input.nodeIds) || input.nodeIds.length < 1)
      )
        fail("INVALID_ARGUMENT", "node screenshot scope requires nodeIds.");
      if (scope !== "node" && input.nodeIds !== undefined)
        fail(
          "INVALID_ARGUMENT",
          `${scope} screenshot scope does not accept nodeIds.`,
        );

      const focusNodes =
        scope === "selection"
          ? [...figma.currentPage.selection]
          : scope === "node"
            ? await Promise.all(input.nodeIds.map(nodeById))
            : [];
      if (scope === "selection" && focusNodes.length === 0)
        fail(
          "INVALID_ARGUMENT",
          "selection screenshot scope requires a non-empty selection.",
        );
      if (input.focus !== false && focusNodes.length > 0)
        figma.viewport.scrollAndZoomIntoView(focusNodes);
      const viewportBounds = finiteBounds(figma.viewport.bounds);
      if (!viewportBounds)
        fail("INTERNAL_ERROR", "Figma viewport bounds are unavailable.");

      return {
        fileName: figma.root.name,
        pageId: figma.currentPage.id,
        scope,
        focusNodeIds: focusNodes.map((node) => node.id),
        viewportBounds,
        ...(focusNodes.length > 0
          ? { focusBounds: unionBounds(focusNodes) }
          : {}),
        leaseId: lease.id,
      };
    } catch (error) {
      if (captureLease?.id === lease.id) captureLease = undefined;
      throw error;
    }
  }

  async function audit(input) {
    if (!Array.isArray(input.rootNodeIds) || input.rootNodeIds.length < 1)
      fail("INVALID_ARGUMENT", "audit requires rootNodeIds.");
    if (
      !Array.isArray(input.categories) ||
      input.categories.length < 1 ||
      input.categories.some((category) => !categories.includes(category))
    )
      fail("INVALID_ARGUMENT", "audit categories are invalid.");
    const maxDepth = input.maxDepth;
    const maxNodes = input.maxNodes;
    const maxIssues = input.maxIssues;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10)
      fail("INVALID_ARGUMENT", "audit maxDepth must be from 0 through 10.");
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 500)
      fail("INVALID_ARGUMENT", "audit maxNodes must be from 1 through 500.");
    if (!Number.isInteger(maxIssues) || maxIssues < 1 || maxIssues > 200)
      fail("INVALID_ARGUMENT", "audit maxIssues must be from 1 through 200.");

    const enabled = new Set(input.categories);
    const roots = await Promise.all(input.rootNodeIds.map(nodeById));
    const visited = new Set();
    const nodes = [];
    let nodeLimitReached = false;
    function walk(node, depth) {
      if (visited.has(node.id) || nodeLimitReached) return;
      if (nodes.length >= maxNodes) {
        nodeLimitReached = true;
        return;
      }
      visited.add(node.id);
      nodes.push({ node, depth });
      if (depth >= maxDepth || !Array.isArray(node.children)) return;
      for (const child of node.children) walk(child, depth + 1);
    }
    for (const root of roots) walk(root, 0);

    const issues = [];
    let issueLimitReached = false;
    function add(category, severity, code, nodeIds, message, evidence = {}) {
      if (issues.length >= maxIssues) {
        issueLimitReached = true;
        return;
      }
      issues.push({ category, severity, code, nodeIds, message, evidence });
    }

    for (const { node } of nodes) {
      const children = Array.isArray(node.children)
        ? node.children.filter(
            (child) => visited.has(child.id) && child.visible !== false,
          )
        : [];

      if (enabled.has("layout")) {
        const parentBounds = layoutBounds(node);
        if (node.clipsContent === true && parentBounds) {
          for (const child of children) {
            const childBounds = layoutBounds(child);
            if (childBounds && exceeds(childBounds, parentBounds))
              add(
                "layout",
                "error",
                "CLIPPED_CONTENT",
                [node.id, child.id],
                `Child ${child.name} extends outside clipping container ${node.name}.`,
                { parentBounds, childBounds },
              );
          }
        }
        const autoLayout = node.layoutMode && node.layoutMode !== "NONE";
        const overlapChildren = children;
        for (
          let leftIndex = 0;
          leftIndex < overlapChildren.length;
          leftIndex++
        ) {
          const left = overlapChildren[leftIndex];
          const leftBounds = layoutBounds(left);
          if (!leftBounds) continue;
          for (
            let rightIndex = leftIndex + 1;
            rightIndex < overlapChildren.length;
            rightIndex++
          ) {
            const right = overlapChildren[rightIndex];
            if (
              autoLayout &&
              left.layoutPositioning !== "ABSOLUTE" &&
              right.layoutPositioning !== "ABSOLUTE"
            )
              continue;
            const rightBounds = layoutBounds(right);
            if (rightBounds && intersects(leftBounds, rightBounds))
              add(
                "layout",
                "warning",
                "OVERLAP",
                [left.id, right.id],
                `Sibling nodes ${left.name} and ${right.name} overlap.`,
                { leftBounds, rightBounds, parentId: node.id },
              );
          }
        }
      }

      if (enabled.has("accessibility")) {
        if (node.type === "TEXT") {
          const size = fontSize(node);
          if (size !== undefined && size < 12)
            add(
              "accessibility",
              "warning",
              "TEXT_TOO_SMALL",
              [node.id],
              `${node.name} uses ${size}px text, below the P0 12px floor.`,
              { fontSize: size, minimum: 12 },
            );
          const foreground = opaqueSolidPaint(node);
          const background = backgroundPaint(node);
          const weight =
            typeof node.fontWeight === "number" &&
            Number.isFinite(node.fontWeight)
              ? node.fontWeight
              : undefined;
          if (
            foreground &&
            background &&
            size !== undefined &&
            weight !== undefined
          ) {
            const ratio = contrastRatio(foreground.color, background.color);
            const large = size >= 24 || (size >= 18.66 && weight >= 700);
            const minimum = large ? 3 : 4.5;
            if (ratio < minimum)
              add(
                "accessibility",
                "error",
                "LOW_TEXT_CONTRAST",
                [node.id],
                `${node.name} has ${ratio.toFixed(2)}:1 solid-color contrast; P0 requires ${minimum}:1.`,
                {
                  ratio: Number(ratio.toFixed(3)),
                  minimum,
                  approximation:
                    "contained text over one opaque solid direct parent; no rotation, intersecting siblings, or effects",
                },
              );
          }
        }
        if (
          /button|btn|link|input|checkbox|radio|switch|icon/i.test(
            node.name || "",
          )
        ) {
          const bounds = nodeBounds(node);
          if (bounds && (bounds.width < 44 || bounds.height < 44))
            add(
              "accessibility",
              "warning",
              "TOUCH_TARGET_TOO_SMALL",
              [node.id],
              `${node.name} is smaller than the P0 44×44 touch-target floor.`,
              { bounds, minimum: { width: 44, height: 44 } },
            );
        }
        if (
          ["COMPONENT", "INSTANCE"].includes(node.type) &&
          /^(component|instance)(\s+\d+)?$/i.test(node.name || "")
        )
          add(
            "accessibility",
            "warning",
            "MISSING_ACCESSIBLE_NAME",
            [node.id],
            `${node.type} ${node.id} keeps a generic name.`,
          );
      }

      if (enabled.has("design_system")) {
        const paint = solidPaint(node);
        if (paint && !boundColor(node, paint))
          add(
            "design_system",
            "info",
            "UNBOUND_SOLID_COLOR",
            [node.id],
            `${node.name} uses a local solid color without a variable binding.`,
          );
        if (
          node.type === "TEXT" &&
          (node.textStyleId === "" || node.textStyleId === undefined)
        )
          add(
            "design_system",
            "info",
            "UNSTYLED_TEXT",
            [node.id],
            `${node.name} does not use a text style.`,
          );
      }

      if (enabled.has("lint")) {
        if (node.visible === false)
          add(
            "lint",
            "info",
            "INVISIBLE_NODE",
            [node.id],
            `${node.name} is hidden.`,
          );
        if (node.type === "TEXT" && String(node.characters || "").trim() === "")
          add(
            "lint",
            "warning",
            "EMPTY_TEXT",
            [node.id],
            `${node.name} is empty.`,
          );
        const names = new Map();
        for (const child of children) {
          const prior = names.get(child.name);
          if (prior)
            add(
              "lint",
              "info",
              "DUPLICATE_SIBLING_NAME",
              [prior.id, child.id],
              `Sibling nodes share the name ${child.name}.`,
              { parentId: node.id },
            );
          else names.set(child.name, child);
        }
      }
    }

    return {
      proof: {
        type: "model-state-audit",
        pixelAnalysis: false,
        checks: {
          accessibility: [
            "opaque single-solid text contrast",
            "12px text floor",
            "44x44 named interactive target floor",
            "generic component/instance names",
          ],
          design_system: ["unbound solid colors", "unstyled text"],
          layout: [
            "clipped direct children",
            "overlapping flow-independent siblings",
          ],
          lint: ["empty text", "hidden nodes", "duplicate sibling names"],
        },
      },
      rootNodeIds: input.rootNodeIds,
      categories: input.categories,
      inspectedNodes: nodes.length,
      maxDepth,
      issues,
      summary: issueSummary(issues),
      truncated: nodeLimitReached || issueLimitReached,
      limits: { maxNodes, maxIssues },
      skippedChecks: [
        "gradient/image contrast",
        "alpha, effects, blend modes, non-parent backgrounds, and intersecting-sibling contrast",
        "semantic runtime accessibility tree",
        "intentional-overlap classification",
      ],
    };
  }

  return {
    captureBlocked,
    command(input) {
      if (input.action === "prepare_capture") return prepareCapture(input);
      if (input.action === "release_capture") return releaseCapture(input);
      if (input.action === "audit") return audit(input);
      fail("INVALID_ARGUMENT", `Unknown visual action ${input.action}.`);
    },
  };
}
