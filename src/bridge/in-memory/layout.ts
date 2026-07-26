import { McpFigError } from "../../errors.js";
import {
  applyLayoutConfig,
  applyLayoutConstraints,
  applyLayoutSizing,
  inspectLayoutNode,
  repairLayoutScope,
  validateLayoutScope,
} from "../layout.js";
import type { LayoutActionInput, LayoutOperation } from "../types.js";
import { clone, type InMemoryStore, nodeDepth } from "./store.js";

export class InMemoryLayout {
  constructor(private readonly store: InMemoryStore) {}

  async layout(input: LayoutActionInput): Promise<Record<string, unknown>> {
    const original = this.store.requireFile(input.fileKey);
    if (input.action === "inspect") {
      return {
        layouts: input.nodeIds.map((nodeId) =>
          inspectLayoutNode(this.store.requireNode(original, nodeId)),
        ),
      };
    }
    if (input.action === "validate") {
      return validateLayoutScope(original.document, input.nodeIds);
    }
    if (input.action === "repair") {
      const beforeValidation = validateLayoutScope(
        original.document,
        input.nodeIds,
      );
      const working = clone(original);
      const repairs = repairLayoutScope(
        working.document,
        input.nodeIds,
        input.issueCodes,
      );
      const afterValidation = validateLayoutScope(
        working.document,
        input.nodeIds,
      );
      const selectedIssueCodes = new Set(input.issueCodes);
      const unresolvedIssues = afterValidation.issues.filter((issue) =>
        selectedIssueCodes.has(issue.code),
      );
      if (repairs.length > 0 && unresolvedIssues.length > 0) {
        throw new McpFigError(
          "INTERNAL_ERROR",
          "Auto Layout repair did not clear every selected issue.",
          { details: { unresolvedIssues } },
        );
      }
      if (repairs.length > 0) {
        const repairedNodeIds = [
          ...new Set(repairs.map((repair) => repair.nodeId)),
        ];
        this.store.record(
          working,
          "layout.repair",
          repairedNodeIds,
          input.dryRun,
        );
        if (!input.dryRun) this.store.replaceFile(working);
      }
      return {
        beforeValidation,
        repairs,
        afterValidation,
        dryRun: input.dryRun ?? false,
      };
    }

    const operations: LayoutOperation[] =
      input.action === "batch"
        ? input.operations
        : input.action === "apply"
          ? [{ op: "apply", nodeIds: input.nodeIds, layout: input.layout }]
          : [{ op: "sizing", nodeIds: input.nodeIds, sizing: input.sizing }];
    const targetIds = [
      ...new Set(operations.flatMap((operation) => operation.nodeIds)),
    ].sort((left, right) => {
      const depthDifference =
        nodeDepth(original.document, left) -
        nodeDepth(original.document, right);
      return depthDifference || left.localeCompare(right);
    });
    const before = targetIds.map((nodeId) =>
      inspectLayoutNode(this.store.requireNode(original, nodeId)),
    );
    const working = clone(original);
    const phase = { apply: 0, sizing: 1, constraints: 2 } as const;
    const units = operations.flatMap((operation, operationIndex) =>
      operation.nodeIds.map((nodeId, nodeIndex) => ({
        operation,
        operationIndex,
        nodeIndex,
        nodeId,
      })),
    );
    units.sort((left, right) => {
      const phaseDifference =
        phase[left.operation.op] - phase[right.operation.op];
      if (phaseDifference !== 0) return phaseDifference;
      const depthDifference =
        nodeDepth(working.document, left.nodeId) -
        nodeDepth(working.document, right.nodeId);
      if (depthDifference !== 0) return depthDifference;
      return (
        left.operationIndex - right.operationIndex ||
        left.nodeIndex - right.nodeIndex
      );
    });

    const appliedOrder: string[] = [];
    for (const unit of units) {
      const node = this.store.requireNode(working, unit.nodeId);
      if (unit.operation.op === "apply") {
        if (
          !["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(
            node.type,
          )
        ) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            `Node ${node.id} does not support Auto Layout.`,
            { details: { nodeId: node.id, nodeType: node.type } },
          );
        }
        applyLayoutConfig(node, unit.operation.layout);
      } else if (unit.operation.op === "sizing") {
        const usesAutomaticSizing =
          unit.operation.sizing.horizontal !== "FIXED" ||
          unit.operation.sizing.vertical !== "FIXED";
        if (usesAutomaticSizing) {
          const parent = node.parentId
            ? this.store.requireNode(working, node.parentId)
            : undefined;
          if (!parent || (parent.layoutMode ?? "NONE") === "NONE") {
            throw new McpFigError(
              "INVALID_ARGUMENT",
              `Node ${node.id} requires an Auto Layout parent for HUG or FILL sizing.`,
              { details: { nodeId: node.id, parentId: node.parentId } },
            );
          }
        }
        applyLayoutSizing(node, unit.operation.sizing);
      } else {
        applyLayoutConstraints(node, unit.operation.constraints);
      }
      appliedOrder.push(`${unit.operation.op}:${node.id}`);
    }

    this.store.record(
      working,
      `layout.${input.action}`,
      targetIds,
      input.dryRun,
    );
    const after = targetIds.map((nodeId) =>
      inspectLayoutNode(this.store.requireNode(working, nodeId)),
    );
    if (!input.dryRun) this.store.replaceFile(working);
    return {
      before,
      after,
      appliedOrder,
      dryRun: input.dryRun ?? false,
    };
  }
}
