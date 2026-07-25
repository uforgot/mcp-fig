// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginNodeHelpers({ figma, fail, countSceneTraversal }) {
  async function nodeById(id) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node)
      fail("NODE_NOT_FOUND", `Figma node ${id} was not found.`, false, {
        nodeId: id,
      });
    return node;
  }

  /**
   * @param {BaseNode} node
   * @returns {node is BaseNode & ChildrenMixin}
   */
  function hasChildren(node) {
    return "children" in node && Array.isArray(node.children);
  }

  function parentId(node) {
    return node.parent && node.parent.type !== "DOCUMENT"
      ? node.parent.id
      : node.parent?.id;
  }

  function serializePaints(paints) {
    return paints === figma.mixed ? undefined : paints;
  }

  async function serializeNode(node, deep = false) {
    countSceneTraversal();
    const output = { id: node.id, type: node.type, name: node.name };
    const parent = parentId(node);
    if (parent) output.parentId = parent;
    for (const key of ["x", "y", "width", "height", "visible", "locked"]) {
      if (key in node && typeof node[key] !== "symbol") output[key] = node[key];
    }
    if (node.type === "TEXT" && node.characters !== figma.mixed)
      output.text = node.characters;
    if ("fills" in node) output.fills = serializePaints(node.fills);
    if ("strokes" in node) output.strokes = serializePaints(node.strokes);
    if (node.type === "COMPONENT") {
      output.componentKey = node.key;
      output.componentSource = "local";
      output.description = node.description;
      output.componentProperties = node.componentPropertyDefinitions;
    }
    if (node.type === "INSTANCE") {
      const mainComponent = await node.getMainComponentAsync();
      output.mainComponentId = mainComponent?.id;
      output.mainComponentKey = mainComponent?.key;
      output.instanceProperties = Object.fromEntries(
        Object.entries(node.componentProperties || {}).map(([key, value]) => [
          key,
          value.value,
        ]),
      );
    }
    if ("boundVariables" in node) {
      output.boundVariables = Object.fromEntries(
        Object.entries(node.boundVariables || {}).map(([key, value]) => [
          key,
          value.id,
        ]),
      );
    }
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
      "layoutPositioning",
      "constraints",
    ]) {
      if (
        key in node &&
        node[key] !== undefined &&
        typeof node[key] !== "symbol"
      )
        output[key] = node[key];
    }
    if (deep && hasChildren(node))
      output.children = await Promise.all(
        node.children.map((child) => serializeNode(child, true)),
      );
    return output;
  }

  async function applyProps(node, props) {
    if (!props) return;
    if (props.name !== undefined) node.name = props.name;
    for (const key of ["x", "y", "visible", "locked"]) {
      if (props[key] !== undefined && key in node) node[key] = props[key];
    }
    if (
      (props.width !== undefined || props.height !== undefined) &&
      "resize" in node
    ) {
      node.resize(props.width ?? node.width, props.height ?? node.height);
    }
    if (props.text !== undefined) {
      if (node.type !== "TEXT")
        fail("INVALID_ARGUMENT", `Node ${node.id} is not a text node.`);
      if (node.fontName === figma.mixed)
        fail("INVALID_ARGUMENT", `Text node ${node.id} uses mixed fonts.`);
      await figma.loadFontAsync(node.fontName);
      node.characters = props.text;
    }
    if (props.fills !== undefined && "fills" in node) node.fills = props.fills;
    if (props.strokes !== undefined && "strokes" in node)
      node.strokes = props.strokes;
  }

  async function validateProps(node, props) {
    if (!props) return;
    if (
      (props.width !== undefined || props.height !== undefined) &&
      !("resize" in node)
    )
      fail("INVALID_ARGUMENT", `Node ${node.id} cannot be resized.`);
    if (props.text !== undefined) {
      if (node.type !== "TEXT")
        fail("INVALID_ARGUMENT", `Node ${node.id} is not a text node.`);
      if (node.fontName === figma.mixed)
        fail("INVALID_ARGUMENT", `Text node ${node.id} uses mixed fonts.`);
      await figma.loadFontAsync(node.fontName);
    }
    if (props.fills !== undefined && !("fills" in node))
      fail("INVALID_ARGUMENT", `Node ${node.id} does not support fills.`);
    if (props.strokes !== undefined && !("strokes" in node))
      fail("INVALID_ARGUMENT", `Node ${node.id} does not support strokes.`);
  }

  function createByType(type) {
    switch (type) {
      case "FRAME":
        return figma.createFrame();
      case "GROUP":
        return fail(
          "UNSUPPORTED_BY_BRIDGE",
          "GROUP creation requires existing child nodes.",
        );
      case "RECTANGLE":
        return figma.createRectangle();
      case "ELLIPSE":
        return figma.createEllipse();
      case "LINE":
        return figma.createLine();
      case "TEXT":
        return figma.createText();
      case "COMPONENT":
        return figma.createComponent();
      default:
        fail(
          "UNSUPPORTED_BY_BRIDGE",
          `Desktop Plugin cannot create ${type} nodes.`,
        );
    }
  }
  return {
    nodeById,
    hasChildren,
    parentId,
    serializeNode,
    applyProps,
    validateProps,
    createByType,
  };
}
