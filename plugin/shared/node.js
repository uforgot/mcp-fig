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

  function toPluginConstraints(constraints) {
    const horizontal = {
      LEFT: "MIN",
      RIGHT: "MAX",
      CENTER: "CENTER",
      LEFT_RIGHT: "STRETCH",
      SCALE: "SCALE",
    };
    const vertical = {
      TOP: "MIN",
      BOTTOM: "MAX",
      CENTER: "CENTER",
      TOP_BOTTOM: "STRETCH",
      SCALE: "SCALE",
    };
    return {
      horizontal: horizontal[constraints.horizontal],
      vertical: vertical[constraints.vertical],
    };
  }

  function fromPluginConstraints(constraints) {
    const horizontal = {
      MIN: "LEFT",
      MAX: "RIGHT",
      CENTER: "CENTER",
      STRETCH: "LEFT_RIGHT",
      SCALE: "SCALE",
    };
    const vertical = {
      MIN: "TOP",
      MAX: "BOTTOM",
      CENTER: "CENTER",
      STRETCH: "TOP_BOTTOM",
      SCALE: "SCALE",
    };
    return {
      horizontal: horizontal[constraints.horizontal] ?? constraints.horizontal,
      vertical: vertical[constraints.vertical] ?? constraints.vertical,
    };
  }

  function normalizeVisual(value) {
    if (typeof value === "number")
      return Math.round(value * 1_000_000) / 1_000_000;
    if (Array.isArray(value)) return value.map(normalizeVisual);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          normalizeVisual(item),
        ]),
      );
    return value;
  }

  function mixedValue(value) {
    return value === figma.mixed ? { mixed: true } : normalizeVisual(value);
  }

  function serializePaint(paint) {
    if (
      paint.type !== "SOLID" &&
      ![
        "GRADIENT_LINEAR",
        "GRADIENT_RADIAL",
        "GRADIENT_ANGULAR",
        "GRADIENT_DIAMOND",
      ].includes(paint.type)
    )
      return normalizeVisual(paint);
    const output = { type: paint.type };
    if (paint.type === "SOLID") output.color = normalizeVisual(paint.color);
    else {
      output.gradientTransform = normalizeVisual(paint.gradientTransform);
      output.gradientStops = normalizeVisual(paint.gradientStops).map(
        (stop) => ({
          position: stop.position,
          color: stop.color,
        }),
      );
    }
    if (paint.opacity !== undefined && paint.opacity !== 1)
      output.opacity = normalizeVisual(paint.opacity);
    if (paint.visible === false) output.visible = false;
    if (paint.blendMode && paint.blendMode !== "NORMAL")
      output.blendMode = paint.blendMode;
    if (paint.boundVariables && Object.keys(paint.boundVariables).length > 0)
      output.boundVariables = normalizeVisual(paint.boundVariables);
    return output;
  }

  function serializePaints(paints) {
    if (paints === figma.mixed) return { mixed: true };
    return paints.map(serializePaint);
  }

  function serializeEffects(effects) {
    if (effects === figma.mixed) return { mixed: true };
    return effects.map((effect) => {
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW")
        return {
          type: effect.type,
          color: normalizeVisual(effect.color),
          offset: normalizeVisual(effect.offset),
          radius: normalizeVisual(effect.radius),
          ...(effect.spread !== undefined
            ? { spread: normalizeVisual(effect.spread) }
            : {}),
          visible: effect.visible,
          blendMode: effect.blendMode,
        };
      if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR")
        return {
          type: effect.type,
          radius: normalizeVisual(effect.radius),
          visible: effect.visible,
          blurType: effect.blurType,
        };
      return normalizeVisual(effect);
    });
  }

  const typographyKeys = [
    "fontName",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "textAlignHorizontal",
    "textAlignVertical",
  ];

  function hasTextMutation(props) {
    return (
      props?.text !== undefined ||
      typographyKeys.some((key) => props?.[key] !== undefined)
    );
  }

  async function loadFontsForTextMutation(node, props) {
    if (!hasTextMutation(props)) return;
    if (node.type !== "TEXT")
      fail("INVALID_ARGUMENT", `Node ${node.id} is not a text node.`);
    if (
      props.text !== undefined &&
      node.fontName === figma.mixed &&
      props.fontName === undefined
    )
      fail(
        "INVALID_ARGUMENT",
        `Text node ${node.id} uses mixed fonts; provide fontName to replace its text uniformly.`,
      );

    let fonts;
    if (props.fontName !== undefined) {
      fonts = [props.fontName];
    } else if (node.fontName !== figma.mixed) {
      fonts = [node.fontName];
    } else if (typeof node.getRangeAllFontNames === "function") {
      fonts = node.getRangeAllFontNames(0, node.characters.length);
    } else {
      fail("INVALID_ARGUMENT", `Text node ${node.id} uses mixed fonts.`);
    }

    const uniqueFonts = new Map(
      fonts.map((font) => [`${font.family}\u0000${font.style}`, font]),
    );
    await Promise.all(
      [...uniqueFonts.values()].map((font) => figma.loadFontAsync(font)),
    );
  }

  function componentDefinitions(node) {
    try {
      return node.componentPropertyDefinitions || {};
    } catch {
      if (node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET")
        return node.parent.componentPropertyDefinitions || {};
      return {};
    }
  }

  async function serializeNode(node, deep = false, countTraversal = true) {
    if (countTraversal) countSceneTraversal();
    const output = { id: node.id, type: node.type, name: node.name };
    const parent = parentId(node);
    if (parent) output.parentId = parent;
    for (const key of ["x", "y", "width", "height", "visible", "locked"]) {
      if (key in node && typeof node[key] !== "symbol") output[key] = node[key];
    }
    if (node.type === "TEXT" && node.characters !== figma.mixed)
      output.text = node.characters;
    if (node.type === "TEXT") {
      for (const key of typographyKeys) {
        if (node[key] !== undefined && node[key] !== figma.mixed)
          output[key] = node[key];
      }
    }
    if ("fills" in node) output.fills = serializePaints(node.fills);
    if ("strokes" in node) output.strokes = serializePaints(node.strokes);
    for (const key of ["opacity", "cornerRadius", "blendMode"]) {
      if (key in node && node[key] !== undefined)
        output[key] = mixedValue(node[key]);
    }
    if ("effects" in node && node.effects !== undefined)
      output.effects = serializeEffects(node.effects);
    if (
      "topLeftRadius" in node &&
      "topRightRadius" in node &&
      "bottomRightRadius" in node &&
      "bottomLeftRadius" in node
    ) {
      output.cornerRadii = {
        topLeft: normalizeVisual(node.topLeftRadius),
        topRight: normalizeVisual(node.topRightRadius),
        bottomRight: normalizeVisual(node.bottomRightRadius),
        bottomLeft: normalizeVisual(node.bottomLeftRadius),
      };
    }
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      output.componentKey = node.key;
      output.componentSource = node.remote ? "library" : "local";
      output.description = node.description;
      output.componentProperties = Object.fromEntries(
        Object.entries(componentDefinitions(node)).map(([name, definition]) => [
          name,
          {
            type: definition.type,
            defaultValue: definition.defaultValue,
            ...(definition.variantOptions
              ? { options: [...definition.variantOptions] }
              : definition.preferredValues
                ? {
                    options: definition.preferredValues.map(
                      (value) => value.key,
                    ),
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
    ]) {
      if (
        key in node &&
        node[key] !== undefined &&
        typeof node[key] !== "symbol"
      )
        output[key] = node[key];
    }
    if ("constraints" in node && node.constraints !== undefined)
      output.constraints = fromPluginConstraints(node.constraints);
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
    if (hasTextMutation(props)) {
      if (props.fontName !== undefined) node.fontName = props.fontName;
      if (props.text !== undefined) node.characters = props.text;
      for (const key of typographyKeys) {
        if (key !== "fontName" && props[key] !== undefined)
          node[key] = props[key];
      }
    }
    if (props.fills !== undefined && "fills" in node) node.fills = props.fills;
    if (props.strokes !== undefined && "strokes" in node)
      node.strokes = props.strokes;
    for (const key of ["opacity", "cornerRadius", "effects", "blendMode"]) {
      if (props[key] !== undefined && key in node) node[key] = props[key];
    }
    if (props.constraints !== undefined && "constraints" in node)
      node.constraints = toPluginConstraints(props.constraints);
  }

  const visualMutationKeys = new Set([
    "fills",
    "strokes",
    "opacity",
    "cornerRadius",
    "effects",
    "blendMode",
    "constraints",
  ]);

  async function validateProps(node, props) {
    if (!props) return;
    for (const key of Object.keys(props)) {
      const property = key === "text" ? "characters" : key;
      if (
        visualMutationKeys.has(key) &&
        property in node &&
        node[property] === figma.mixed
      )
        fail(
          "INVALID_ARGUMENT",
          `Node ${node.id} has mixed ${property}; whole-node mutation is unsupported.`,
        );
    }
    if (
      (props.width !== undefined || props.height !== undefined) &&
      !("resize" in node)
    )
      fail("INVALID_ARGUMENT", `Node ${node.id} cannot be resized.`);
    await loadFontsForTextMutation(node, props);
    if (props.fills !== undefined && !("fills" in node))
      fail("INVALID_ARGUMENT", `Node ${node.id} does not support fills.`);
    if (props.strokes !== undefined && !("strokes" in node))
      fail("INVALID_ARGUMENT", `Node ${node.id} does not support strokes.`);
    for (const key of [
      "opacity",
      "cornerRadius",
      "effects",
      "blendMode",
      "constraints",
    ]) {
      if (props[key] !== undefined && !(key in node))
        fail("INVALID_ARGUMENT", `Node ${node.id} does not support ${key}.`);
    }
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
    toPluginConstraints,
    fromPluginConstraints,
    serializeNode,
    serializePaints,
    applyProps,
    validateProps,
    createByType,
  };
}
