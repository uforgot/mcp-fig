import { McpFigError } from "../../errors.js";
import type {
  ChangeRecord,
  ComponentRecord,
  FigmaFileFixture,
  FigmaNode,
  FigmaStyleRecord,
  FigmaVariable,
  VariableCollection,
} from "../types.js";

export interface StoredFile extends FigmaFileFixture {
  selection: string[];
  libraryComponents: ComponentRecord[];
  variableCollections: VariableCollection[];
  variables: FigmaVariable[];
  styles: FigmaStyleRecord[];
  revisionNumber: number;
  changes: ChangeRecord[];
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function findNode(
  root: FigmaNode,
  nodeId: string,
): FigmaNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

export function countNodes(root: FigmaNode): number {
  return (
    1 + (root.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
  );
}

export function containsNode(root: FigmaNode, nodeId: string): boolean {
  return findNode(root, nodeId) !== undefined;
}

export function nodeDepth(root: FigmaNode, nodeId: string, depth = 0): number {
  if (root.id === nodeId) return depth;
  for (const child of root.children ?? []) {
    const childDepth = nodeDepth(child, nodeId, depth + 1);
    if (childDepth >= 0) return childDepth;
  }
  return -1;
}

export class InMemoryStore {
  readonly files = new Map<string, StoredFile>();
  activeFileKey?: string;

  constructor(fixtures: FigmaFileFixture[], activeFileKey?: string) {
    for (const fixture of fixtures) {
      this.files.set(fixture.key, {
        ...clone(fixture),
        selection: [...(fixture.selection ?? [])],
        libraryComponents: clone(fixture.libraryComponents ?? []),
        variableCollections: clone(fixture.variableCollections ?? []),
        variables: clone(fixture.variables ?? []),
        styles: clone(fixture.styles ?? []),
        revisionNumber: 1,
        changes: [],
      });
    }
    if (activeFileKey) {
      this.requireFile(activeFileKey);
      this.activeFileKey = activeFileKey;
    }
  }

  replaceFile(file: StoredFile): void {
    this.files.set(file.key, file);
  }

  requireFile(fileKey?: string): StoredFile {
    const key = fileKey ?? this.activeFileKey;
    if (!key) {
      throw new McpFigError(
        "FILE_NOT_TARGETED",
        "No Figma file is targeted. Use figma_connection.target first.",
      );
    }
    const file = this.files.get(key);
    if (!file) {
      throw new McpFigError(
        "FILE_NOT_FOUND",
        `Figma file ${key} was not found.`,
        {
          details: { fileKey: key },
        },
      );
    }
    return file;
  }

  requireNode(file: StoredFile, nodeId: string): FigmaNode {
    const node = findNode(file.document, nodeId);
    if (!node) {
      throw new McpFigError(
        "NODE_NOT_FOUND",
        `Figma node ${nodeId} was not found.`,
        {
          details: { fileKey: file.key, nodeId },
        },
      );
    }
    return node;
  }

  workingFile(fileKey: string | undefined, dryRun = false): StoredFile {
    const file = this.requireFile(fileKey);
    return dryRun ? clone(file) : file;
  }

  removeFromParent(file: StoredFile, node: FigmaNode): void {
    if (!node.parentId) return;
    const parent = this.requireNode(file, node.parentId);
    const index =
      parent.children?.findIndex((child) => child.id === node.id) ?? -1;
    if (index >= 0) parent.children?.splice(index, 1);
  }

  cloneNode(
    file: StoredFile,
    source: FigmaNode,
    parentId: string,
    reserved = new Set<string>(),
  ): FigmaNode {
    const copied: FigmaNode = {
      ...clone(source),
      id: this.newNodeId(file, reserved),
      parentId,
    };
    if (source.children) {
      copied.children = source.children.map((child) =>
        this.cloneNode(file, child, copied.id, reserved),
      );
    }
    return copied;
  }

  newNodeId(file: StoredFile, reserved = new Set<string>()): string {
    let index = 1;
    let nodeId = `mcp:${index}`;
    while (findNode(file.document, nodeId) || reserved.has(nodeId)) {
      index += 1;
      nodeId = `mcp:${index}`;
    }
    reserved.add(nodeId);
    return nodeId;
  }

  record(
    file: StoredFile,
    action: string,
    nodeIds: string[],
    dryRun = false,
  ): void {
    if (dryRun) return;
    file.revisionNumber += 1;
    file.changes.push({
      revision: this.revision(file),
      action,
      nodeIds: [...nodeIds],
      timestamp: new Date().toISOString(),
    });
  }

  revision(file: StoredFile): string {
    return `fixture-r${file.revisionNumber}`;
  }
}
