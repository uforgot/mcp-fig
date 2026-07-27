import type {
  FigmaNode,
  NodeQueryMatch,
  NodeQueryResult,
  QueryNodesInput,
} from "./types.js";

function comparable(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLocaleLowerCase("en-US");
}

function samePath(
  actual: string[],
  expected: string[],
  caseSensitive: boolean,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (segment, index) =>
        comparable(segment, caseSensitive) ===
        comparable(expected[index] ?? "", caseSensitive),
    )
  );
}

function shallowNode(node: FigmaNode): FigmaNode {
  const { children: _children, ...snapshot } = node;
  return snapshot;
}

export function querySerializedNodes(
  root: FigmaNode,
  input: QueryNodesInput,
): NodeQueryResult {
  const matches: NodeQueryMatch[] = [];
  const caseSensitive = input.caseSensitive ?? true;
  const nameMatch = input.nameMatch ?? "exact";
  const expectedName =
    input.name === undefined
      ? undefined
      : comparable(input.name, caseSensitive);
  let truncated = false;

  const visit = (node: FigmaNode, path: string[], depth: number): boolean => {
    if (depth > input.maxDepth) return false;
    const actualName = comparable(node.name, caseSensitive);
    const nameMatches =
      expectedName === undefined ||
      (nameMatch === "contains"
        ? actualName.includes(expectedName)
        : actualName === expectedName);
    const typeMatches =
      input.nodeType === undefined || node.type === input.nodeType;
    const pathMatches =
      input.path === undefined || samePath(path, input.path, caseSensitive);

    if (nameMatches && typeMatches && pathMatches) {
      if (matches.length === input.limit) {
        truncated = true;
        return true;
      }
      matches.push({ node: shallowNode(node), path: [...path] });
    }
    if (depth === input.maxDepth) return false;
    for (const child of node.children ?? []) {
      if (visit(child, [...path, child.name], depth + 1)) return true;
    }
    return false;
  };

  for (const child of root.children ?? []) {
    if (visit(child, [child.name], 1)) break;
  }
  return { matches, limit: input.limit, truncated };
}
