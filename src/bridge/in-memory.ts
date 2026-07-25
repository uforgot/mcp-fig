import { McpFigError } from "../errors.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  CreateNodeInput,
  DeleteNodesInput,
  FigmaBridge,
  FigmaFileFixture,
  FigmaFileSummary,
  FigmaNode,
  MoveNodesInput,
  ResizeNodesInput,
  UpdateNodesInput,
} from "./types.js";

interface StoredFile extends FigmaFileFixture {
  selection: string[];
  revisionNumber: number;
  changes: ChangeRecord[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findNode(root: FigmaNode, nodeId: string): FigmaNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

function countNodes(root: FigmaNode): number {
  return (
    1 + (root.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
  );
}

function containsNode(root: FigmaNode, nodeId: string): boolean {
  return findNode(root, nodeId) !== undefined;
}

export class InMemoryFigmaBridge implements FigmaBridge {
  readonly #files = new Map<string, StoredFile>();
  #activeFileKey?: string;
  #nextNodeId = 1;

  constructor(fixtures: FigmaFileFixture[], activeFileKey?: string) {
    for (const fixture of fixtures) {
      this.#files.set(fixture.key, {
        ...clone(fixture),
        selection: [...(fixture.selection ?? [])],
        revisionNumber: 1,
        changes: [],
      });
    }
    if (activeFileKey) {
      this.#requireFile(activeFileKey);
      this.#activeFileKey = activeFileKey;
    }
  }

  async status(): Promise<BridgeStatus> {
    const file = this.#activeFileKey
      ? this.#files.get(this.#activeFileKey)
      : undefined;
    return {
      connected: this.#files.size > 0,
      mode: "fixture",
      ...(file
        ? {
            fileKey: file.key,
            fileName: file.name,
            revision: this.#revision(file),
          }
        : {}),
      readSource: "fixture",
      writeSource: "fixture",
    };
  }

  async listFiles(): Promise<FigmaFileSummary[]> {
    return [...this.#files.values()].map((file) => ({
      key: file.key,
      name: file.name,
      revision: this.#revision(file),
    }));
  }

  async targetFile(fileKey: string): Promise<BridgeStatus> {
    this.#requireFile(fileKey);
    this.#activeFileKey = fileKey;
    return this.status();
  }

  async reconnect(): Promise<BridgeStatus> {
    return this.status();
  }

  async getDocument(fileKey?: string): Promise<FigmaNode> {
    return clone(this.#requireFile(fileKey).document);
  }

  async getSelection(fileKey?: string): Promise<string[]> {
    return [...this.#requireFile(fileKey).selection];
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    return clone(this.#requireFile(fileKey).changes);
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    const file = this.#requireFile(fileKey);
    return nodeIds.map((nodeId) => clone(this.#requireNode(file, nodeId)));
  }

  async createNode(input: CreateNodeInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const parent = this.#requireNode(file, input.parentId);
    const node: FigmaNode = {
      id: this.#newNodeId(file),
      type: input.nodeType,
      name: input.name ?? input.nodeType.toLowerCase(),
      parentId: parent.id,
      ...clone(input.props ?? {}),
      ...(this.#canHaveChildren(input.nodeType) ? { children: [] } : {}),
    };
    parent.children ??= [];
    parent.children.push(node);
    this.#record(file, "create", [node.id], input.dryRun);
    return [clone(node)];
  }

  async updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    for (const node of nodes) Object.assign(node, clone(input.patch));
    this.#record(file, "update", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async moveNodes(input: MoveNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    const destination = input.parentId
      ? this.#requireNode(file, input.parentId)
      : undefined;

    if (destination) {
      for (const node of nodes) {
        if (node.id === destination.id || containsNode(node, destination.id)) {
          throw new McpFigError(
            "INVALID_ARGUMENT",
            `Node ${node.id} cannot be moved into itself or its descendant.`,
          );
        }
      }
      destination.children ??= [];
    }

    for (const [offset, node] of nodes.entries()) {
      if (destination) {
        this.#removeFromParent(file, node);
        node.parentId = destination.id;
        const index = Math.min(
          input.index === undefined
            ? (destination.children?.length ?? 0)
            : input.index + offset,
          destination.children?.length ?? 0,
        );
        destination.children?.splice(index, 0, node);
      }
      if (input.x !== undefined) node.x = input.x;
      if (input.y !== undefined) node.y = input.y;
    }
    this.#record(file, "move", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    for (const node of nodes) {
      node.width = input.size.width;
      node.height = input.size.height;
    }
    this.#record(file, "resize", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const sourceNodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    const clones: FigmaNode[] = [];

    for (const source of sourceNodes) {
      const destination = input.parentId
        ? this.#requireNode(file, input.parentId)
        : source.parentId
          ? this.#requireNode(file, source.parentId)
          : undefined;
      if (!destination) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Root node ${source.id} cannot be cloned without a destination parent.`,
        );
      }
      destination.children ??= [];
      const copied = this.#cloneNode(file, source, destination.id);
      copied.x = (source.x ?? 0) + (input.offset?.x ?? 0);
      copied.y = (source.y ?? 0) + (input.offset?.y ?? 0);
      destination.children.push(copied);
      clones.push(copied);
    }
    this.#record(
      file,
      "clone",
      clones.map((node) => node.id),
      input.dryRun,
    );
    return clone(clones);
  }

  async deleteNodes(input: DeleteNodesInput): Promise<string[]> {
    const file = this.#workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.#requireNode(file, nodeId),
    );
    for (const node of nodes) {
      if (!node.parentId) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Root node ${node.id} cannot be deleted.`,
        );
      }
    }
    for (const node of nodes) this.#removeFromParent(file, node);
    file.selection = file.selection.filter(
      (nodeId) => !input.nodeIds.includes(nodeId),
    );
    this.#record(file, "delete", input.nodeIds, input.dryRun);
    return [...input.nodeIds];
  }

  countNodes(fileKey?: string): number {
    return countNodes(this.#requireFile(fileKey).document);
  }

  #requireFile(fileKey?: string): StoredFile {
    const key = fileKey ?? this.#activeFileKey;
    if (!key) {
      throw new McpFigError(
        "FILE_NOT_TARGETED",
        "No Figma file is targeted. Use figma_connection.target first.",
      );
    }
    const file = this.#files.get(key);
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

  #requireNode(file: StoredFile, nodeId: string): FigmaNode {
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

  #workingFile(fileKey: string | undefined, dryRun = false): StoredFile {
    const file = this.#requireFile(fileKey);
    return dryRun ? clone(file) : file;
  }

  #removeFromParent(file: StoredFile, node: FigmaNode): void {
    if (!node.parentId) return;
    const parent = this.#requireNode(file, node.parentId);
    const index =
      parent.children?.findIndex((child) => child.id === node.id) ?? -1;
    if (index >= 0) parent.children?.splice(index, 1);
  }

  #cloneNode(file: StoredFile, source: FigmaNode, parentId: string): FigmaNode {
    const copied: FigmaNode = {
      ...clone(source),
      id: this.#newNodeId(file),
      parentId,
    };
    if (source.children) {
      copied.children = source.children.map((child) =>
        this.#cloneNode(file, child, copied.id),
      );
    }
    return copied;
  }

  #newNodeId(file: StoredFile): string {
    let nodeId = `mcp:${this.#nextNodeId++}`;
    while (findNode(file.document, nodeId)) {
      nodeId = `mcp:${this.#nextNodeId++}`;
    }
    return nodeId;
  }

  #record(
    file: StoredFile,
    action: string,
    nodeIds: string[],
    dryRun = false,
  ): void {
    if (dryRun) return;
    file.revisionNumber += 1;
    file.changes.push({
      revision: this.#revision(file),
      action,
      nodeIds: [...nodeIds],
      timestamp: new Date().toISOString(),
    });
  }

  #revision(file: StoredFile): string {
    return `fixture-r${file.revisionNumber}`;
  }

  #canHaveChildren(type: FigmaNode["type"]): boolean {
    return ["DOCUMENT", "PAGE", "FRAME", "GROUP", "COMPONENT"].includes(type);
  }
}
