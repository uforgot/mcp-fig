import { McpFigError } from "../errors.js";
import type {
  FigmaNode,
  LayoutConfig,
  LayoutConstraints,
  LayoutIssue,
  LayoutIssueCode,
  LayoutRepair,
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
      ...(node.layoutPositioning !== undefined
        ? { layoutPositioning: node.layoutPositioning }
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

export const REPAIRABLE_LAYOUT_ISSUE_CODES = [
  "FILL_IN_HUG_PARENT_HORIZONTAL",
  "FILL_IN_HUG_PARENT_VERTICAL",
  "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
  "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
] as const satisfies readonly LayoutIssueCode[];

export function validateLayoutScope(
  root: FigmaNode,
  nodeIds: string[],
): { valid: boolean; issues: LayoutIssue[] } {
  const nodes = collectScope(root, nodeIds);
  const issues = nodes.flatMap((node) => diagnoseNode(root, node));
  return { valid: issues.length === 0, issues };
}

export function repairLayoutScope(
  root: FigmaNode,
  nodeIds: string[],
  issueCodes: LayoutIssueCode[],
): LayoutRepair[] {
  const unsafeIssueCodes = [
    ...new Set(
      issueCodes.filter(
        (code) =>
          !REPAIRABLE_LAYOUT_ISSUE_CODES.includes(
            code as (typeof REPAIRABLE_LAYOUT_ISSUE_CODES)[number],
          ),
      ),
    ),
  ];
  if (unsafeIssueCodes.length > 0) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      "The requested repair set contains issues that require design intent.",
      { details: { unsafeIssueCodes } },
    );
  }

  const selectedCodes = new Set(issueCodes);
  const issues = validateLayoutScope(root, nodeIds).issues.filter((issue) =>
    selectedCodes.has(issue.code),
  );
  return issues.map((issue) => repairIssue(root, issue));
}

function diagnoseNode(root: FigmaNode, node: FigmaNode): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  if (
    node.minWidth !== undefined &&
    node.maxWidth !== undefined &&
    node.minWidth > node.maxWidth
  ) {
    issues.push({
      code: "MIN_MAX_CONFLICT_WIDTH",
      nodeId: node.id,
      axis: "horizontal",
      message: `Node ${node.id} has a minimum width greater than its maximum width.`,
      repairable: false,
      details: { minimum: node.minWidth, maximum: node.maxWidth },
    });
  }
  if (
    node.minHeight !== undefined &&
    node.maxHeight !== undefined &&
    node.minHeight > node.maxHeight
  ) {
    issues.push({
      code: "MIN_MAX_CONFLICT_HEIGHT",
      nodeId: node.id,
      axis: "vertical",
      message: `Node ${node.id} has a minimum height greater than its maximum height.`,
      repairable: false,
      details: { minimum: node.minHeight, maximum: node.maxHeight },
    });
  }

  const parent = node.parentId
    ? findLayoutNode(root, node.parentId)
    : undefined;
  if ((node.layoutPositioning ?? "AUTO") !== "ABSOLUTE") {
    for (const axis of ["horizontal", "vertical"] as const) {
      const property =
        axis === "horizontal"
          ? ("layoutSizingHorizontal" as const)
          : ("layoutSizingVertical" as const);
      const sizing = node[property] ?? "FIXED";
      if (sizing !== "HUG" && sizing !== "FILL") continue;
      if (!parent || (parent.layoutMode ?? "NONE") === "NONE") {
        issues.push({
          code:
            sizing === "HUG"
              ? "HUG_WITHOUT_AUTO_LAYOUT_PARENT"
              : "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
          nodeId: node.id,
          axis,
          message: `Node ${node.id} uses ${sizing} on the ${axis} axis without an Auto Layout parent.`,
          repairable: true,
          details: { axis, property, parentId: node.parentId, current: sizing },
        });
        continue;
      }
      if (sizing === "FILL" && parentAxisSizing(parent, axis) === "AUTO") {
        issues.push({
          code:
            axis === "horizontal"
              ? "FILL_IN_HUG_PARENT_HORIZONTAL"
              : "FILL_IN_HUG_PARENT_VERTICAL",
          nodeId: node.id,
          axis,
          message: `Node ${node.id} uses FILL on the ${axis} axis while its parent hugs that axis.`,
          repairable: true,
          details: { axis, property, parentId: parent.id, current: sizing },
        });
      }
    }
  }

  issues.push(...diagnoseOverflow(node));
  return issues;
}

function diagnoseOverflow(node: FigmaNode): LayoutIssue[] {
  if (
    (node.layoutMode ?? "NONE") === "NONE" ||
    (node.layoutWrap ?? "NO_WRAP") === "WRAP"
  ) {
    return [];
  }
  const children = (node.children ?? []).filter(
    (child) =>
      child.visible !== false &&
      (child.layoutPositioning ?? "AUTO") !== "ABSOLUTE",
  );
  if (children.length === 0) return [];
  const gap = node.itemSpacing ?? 0;
  const horizontal = node.layoutMode === "HORIZONTAL";
  const horizontalRequired =
    (node.paddingLeft ?? 0) +
    (node.paddingRight ?? 0) +
    (horizontal
      ? children.reduce(
          (sum, child) => sum + childExtent(child, "horizontal"),
          0,
        ) +
        gap * Math.max(0, children.length - 1)
      : Math.max(...children.map((child) => childExtent(child, "horizontal"))));
  const verticalRequired =
    (node.paddingTop ?? 0) +
    (node.paddingBottom ?? 0) +
    (horizontal
      ? Math.max(...children.map((child) => childExtent(child, "vertical")))
      : children.reduce(
          (sum, child) => sum + childExtent(child, "vertical"),
          0,
        ) +
        gap * Math.max(0, children.length - 1));
  const issues: LayoutIssue[] = [];
  if (
    node.width !== undefined &&
    parentAxisSizing(node, "horizontal") === "FIXED" &&
    horizontalRequired > node.width
  ) {
    issues.push(
      overflowIssue(node, "horizontal", horizontalRequired, node.width),
    );
  }
  if (
    node.height !== undefined &&
    parentAxisSizing(node, "vertical") === "FIXED" &&
    verticalRequired > node.height
  ) {
    issues.push(overflowIssue(node, "vertical", verticalRequired, node.height));
  }
  return issues;
}

function overflowIssue(
  node: FigmaNode,
  axis: "horizontal" | "vertical",
  required: number,
  available: number,
): LayoutIssue {
  return {
    code:
      axis === "horizontal"
        ? "AUTO_LAYOUT_OVERFLOW_HORIZONTAL"
        : "AUTO_LAYOUT_OVERFLOW_VERTICAL",
    nodeId: node.id,
    axis,
    message: `Auto Layout node ${node.id} overflows its ${axis} bounds by ${required - available}px.`,
    repairable: false,
    details: { axis, required, available, overflowBy: required - available },
  };
}

function childExtent(node: FigmaNode, axis: "horizontal" | "vertical"): number {
  const sizing =
    axis === "horizontal"
      ? (node.layoutSizingHorizontal ?? "FIXED")
      : (node.layoutSizingVertical ?? "FIXED");
  const minimum = axis === "horizontal" ? node.minWidth : node.minHeight;
  if (sizing === "FILL") return minimum ?? 0;
  return (axis === "horizontal" ? node.width : node.height) ?? minimum ?? 0;
}

function parentAxisSizing(
  node: FigmaNode,
  axis: "horizontal" | "vertical",
): "FIXED" | "AUTO" {
  const primary =
    (node.layoutMode === "HORIZONTAL" && axis === "horizontal") ||
    (node.layoutMode === "VERTICAL" && axis === "vertical");
  return primary
    ? (node.primaryAxisSizingMode ?? "FIXED")
    : (node.counterAxisSizingMode ?? "FIXED");
}

function collectScope(root: FigmaNode, nodeIds: string[]): FigmaNode[] {
  const result: FigmaNode[] = [];
  const visited = new Set<string>();
  const visit = (node: FigmaNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    result.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const nodeId of nodeIds) {
    const node = findLayoutNode(root, nodeId);
    if (!node) {
      throw new McpFigError("NODE_NOT_FOUND", `Node ${nodeId} was not found.`, {
        details: { nodeId },
      });
    }
    visit(node);
  }
  return result;
}

export function findLayoutNode(
  root: FigmaNode,
  nodeId: string,
): FigmaNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const match = findLayoutNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

function repairIssue(root: FigmaNode, issue: LayoutIssue): LayoutRepair {
  const node = findLayoutNode(root, issue.nodeId);
  if (!node) {
    throw new McpFigError(
      "NODE_NOT_FOUND",
      `Node ${issue.nodeId} was not found.`,
    );
  }
  const property = issue.details.property;
  if (
    property !== "layoutSizingHorizontal" &&
    property !== "layoutSizingVertical"
  ) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Issue ${issue.code} has no deterministic repair.`,
    );
  }
  const from = node[property] ?? "FIXED";
  node[property] = "FIXED";
  return {
    issueCode: issue.code,
    nodeId: node.id,
    reason: `${issue.message} FIXED preserves the current measured size without guessing design intent.`,
    changes: [{ property, from, to: "FIXED" }],
  };
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
