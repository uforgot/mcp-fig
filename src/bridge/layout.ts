import { McpFigError } from "../errors.js";
import type {
  FigmaNode,
  LayoutConfig,
  LayoutConstraints,
  LayoutSizingConfig,
  LayoutSnapshot,
} from "./types.js";

export function inspectLayoutNode(node: FigmaNode): LayoutSnapshot {
  return {
    nodeId: node.id,
    name: node.name,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    childIds: (node.children ?? []).map((child) => child.id),
    layout: {
      layoutMode: node.layoutMode ?? "NONE",
      gap: node.itemSpacing ?? 0,
      itemSpacing: node.itemSpacing ?? 0,
      padding: {
        top: node.paddingTop ?? 0,
        right: node.paddingRight ?? 0,
        bottom: node.paddingBottom ?? 0,
        left: node.paddingLeft ?? 0,
      },
      primaryAxisAlignItems: node.primaryAxisAlignItems ?? "MIN",
      counterAxisAlignItems: node.counterAxisAlignItems ?? "MIN",
      layoutWrap: node.layoutWrap ?? "NO_WRAP",
      primaryAxisSizingMode: node.primaryAxisSizingMode ?? "FIXED",
      counterAxisSizingMode: node.counterAxisSizingMode ?? "FIXED",
    },
    sizing: {
      horizontal: node.layoutSizingHorizontal ?? "FIXED",
      vertical: node.layoutSizingVertical ?? "FIXED",
      ...(node.minWidth !== undefined ? { minWidth: node.minWidth } : {}),
      ...(node.maxWidth !== undefined ? { maxWidth: node.maxWidth } : {}),
      ...(node.minHeight !== undefined ? { minHeight: node.minHeight } : {}),
      ...(node.maxHeight !== undefined ? { maxHeight: node.maxHeight } : {}),
      ...(node.layoutAlign !== undefined
        ? { layoutAlign: node.layoutAlign }
        : {}),
    },
    constraints: node.constraints ?? { horizontal: "LEFT", vertical: "TOP" },
  };
}

export function applyLayoutConfig(node: FigmaNode, layout: LayoutConfig): void {
  node.layoutMode = layout.layoutMode;
  const gap = layout.gap ?? layout.itemSpacing;
  if (gap !== undefined) node.itemSpacing = gap;
  if (layout.padding !== undefined) {
    const padding =
      typeof layout.padding === "number"
        ? {
            top: layout.padding,
            right: layout.padding,
            bottom: layout.padding,
            left: layout.padding,
          }
        : layout.padding;
    node.paddingTop = padding.top;
    node.paddingRight = padding.right;
    node.paddingBottom = padding.bottom;
    node.paddingLeft = padding.left;
  }
  if (layout.primaryAxisAlignItems !== undefined) {
    node.primaryAxisAlignItems = layout.primaryAxisAlignItems;
  }
  if (layout.counterAxisAlignItems !== undefined) {
    node.counterAxisAlignItems = layout.counterAxisAlignItems;
  }
  if (layout.layoutWrap !== undefined) node.layoutWrap = layout.layoutWrap;
  if (layout.primaryAxisSizingMode !== undefined) {
    node.primaryAxisSizingMode = layout.primaryAxisSizingMode;
  }
  if (layout.counterAxisSizingMode !== undefined) {
    node.counterAxisSizingMode = layout.counterAxisSizingMode;
  }
}

export function applyLayoutSizing(
  node: FigmaNode,
  sizing: LayoutSizingConfig,
): void {
  validateBounds(
    "width",
    sizing.minWidth ?? node.minWidth,
    sizing.maxWidth ?? node.maxWidth,
  );
  validateBounds(
    "height",
    sizing.minHeight ?? node.minHeight,
    sizing.maxHeight ?? node.maxHeight,
  );
  node.layoutSizingHorizontal = sizing.horizontal;
  node.layoutSizingVertical = sizing.vertical;
  if (sizing.minWidth !== undefined) node.minWidth = sizing.minWidth;
  if (sizing.maxWidth !== undefined) node.maxWidth = sizing.maxWidth;
  if (sizing.minHeight !== undefined) node.minHeight = sizing.minHeight;
  if (sizing.maxHeight !== undefined) node.maxHeight = sizing.maxHeight;
  if (sizing.layoutAlign !== undefined) node.layoutAlign = sizing.layoutAlign;
}

export function applyLayoutConstraints(
  node: FigmaNode,
  constraints: LayoutConstraints,
): void {
  node.constraints = { ...constraints };
}

function validateBounds(
  axis: string,
  minimum: number | undefined,
  maximum: number | undefined,
): void {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Minimum ${axis} cannot exceed maximum ${axis}.`,
      { details: { axis, minimum, maximum } },
    );
  }
}
