import { McpFigError } from "../../errors.js";
import { querySerializedNodes } from "../node-query.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  CreateNodeInput,
  DeleteNodesInput,
  FigmaFileSummary,
  FigmaNode,
  MoveNodesInput,
  NodeProps,
  NodeQueryResult,
  QueryNodesInput,
  ResizeNodesInput,
  UpdateNodesInput,
} from "../types.js";
import {
  clone,
  containsNode,
  countNodes,
  type InMemoryStore,
} from "./store.js";

function canHaveChildren(type: FigmaNode["type"]): boolean {
  return ["DOCUMENT", "PAGE", "FRAME", "GROUP", "COMPONENT"].includes(type);
}

const sceneNodeTypes = new Set([
  "FRAME",
  "GROUP",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "TEXT",
  "COMPONENT",
  "INSTANCE",
]);
const cornerNodeTypes = new Set([
  "FRAME",
  "RECTANGLE",
  "COMPONENT",
  "INSTANCE",
]);

function validateProps(
  node: Pick<FigmaNode, "id" | "type">,
  props?: NodeProps,
): void {
  if (!props) return;
  for (const key of ["fills", "strokes"] as const) {
    if (props[key] !== undefined && !sceneNodeTypes.has(node.type)) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Node ${node.id} does not support ${key}.`,
      );
    }
  }
  for (const key of [
    "opacity",
    "effects",
    "blendMode",
    "constraints",
  ] as const) {
    if (props[key] !== undefined && !sceneNodeTypes.has(node.type)) {
      throw new McpFigError(
        "INVALID_ARGUMENT",
        `Node ${node.id} does not support ${key}.`,
      );
    }
  }
  if (props.cornerRadius !== undefined && !cornerNodeTypes.has(node.type)) {
    throw new McpFigError(
      "INVALID_ARGUMENT",
      `Node ${node.id} does not support cornerRadius.`,
    );
  }
}

export class InMemoryCore {
  constructor(private readonly store: InMemoryStore) {}

  async status(): Promise<BridgeStatus> {
    const file = this.store.activeFileKey
      ? this.store.files.get(this.store.activeFileKey)
      : undefined;
    return {
      connected: this.store.files.size > 0,
      mode: "fixture",
      ...(file
        ? {
            fileKey: file.key,
            fileName: file.name,
            revision: this.store.revision(file),
          }
        : {}),
      readSource: "fixture",
      writeSource: "fixture",
    };
  }

  async listFiles(): Promise<FigmaFileSummary[]> {
    return [...this.store.files.values()].map((file) => ({
      key: file.key,
      name: file.name,
      revision: this.store.revision(file),
    }));
  }

  async targetFile(fileKey: string): Promise<BridgeStatus> {
    this.store.requireFile(fileKey);
    this.store.activeFileKey = fileKey;
    return this.status();
  }

  async reconnect(): Promise<BridgeStatus> {
    return this.status();
  }

  async getDocument(fileKey?: string): Promise<FigmaNode> {
    return clone(this.store.requireFile(fileKey).document);
  }

  async getSelection(fileKey?: string): Promise<string[]> {
    return [...this.store.requireFile(fileKey).selection];
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    return clone(this.store.requireFile(fileKey).changes);
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    const file = this.store.requireFile(fileKey);
    return nodeIds.map((nodeId) => clone(this.store.requireNode(file, nodeId)));
  }

  async queryNodes(input: QueryNodesInput): Promise<NodeQueryResult> {
    const file = this.store.requireFile(input.fileKey);
    const root = input.rootId
      ? this.store.requireNode(file, input.rootId)
      : file.document;
    return clone(querySerializedNodes(root, input));
  }

  async createNode(input: CreateNodeInput): Promise<FigmaNode[]> {
    const file = this.store.workingFile(input.fileKey, input.dryRun);
    const parent = this.store.requireNode(file, input.parentId);
    validateProps({ id: "preview:new", type: input.nodeType }, input.props);
    const node: FigmaNode = {
      id: this.store.newNodeId(file),
      type: input.nodeType,
      name: input.name ?? input.nodeType.toLowerCase(),
      parentId: parent.id,
      ...clone(input.props ?? {}),
      ...(canHaveChildren(input.nodeType) ? { children: [] } : {}),
    };
    parent.children ??= [];
    parent.children.push(node);
    this.store.record(file, "create", [node.id], input.dryRun);
    return [clone(node)];
  }

  async updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]> {
    const file = this.store.workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.store.requireNode(file, nodeId),
    );
    for (const node of nodes) validateProps(node, input.patch);
    for (const node of nodes) Object.assign(node, clone(input.patch));
    this.store.record(file, "update", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async moveNodes(input: MoveNodesInput): Promise<FigmaNode[]> {
    const file = this.store.workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.store.requireNode(file, nodeId),
    );
    const destination = input.parentId
      ? this.store.requireNode(file, input.parentId)
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
        this.store.removeFromParent(file, node);
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
    this.store.record(file, "move", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]> {
    const file = this.store.workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.store.requireNode(file, nodeId),
    );
    for (const node of nodes) {
      node.width = input.size.width;
      node.height = input.size.height;
    }
    this.store.record(file, "resize", input.nodeIds, input.dryRun);
    return clone(nodes);
  }

  async cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]> {
    const file = this.store.workingFile(input.fileKey, input.dryRun);
    const sourceNodes = input.nodeIds.map((nodeId) =>
      this.store.requireNode(file, nodeId),
    );
    const clones: FigmaNode[] = [];

    for (const source of sourceNodes) {
      const destination = input.parentId
        ? this.store.requireNode(file, input.parentId)
        : source.parentId
          ? this.store.requireNode(file, source.parentId)
          : undefined;
      if (!destination) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Root node ${source.id} cannot be cloned without a destination parent.`,
        );
      }
      destination.children ??= [];
      const copied = this.store.cloneNode(file, source, destination.id);
      copied.x = (source.x ?? 0) + (input.offset?.x ?? 0);
      copied.y = (source.y ?? 0) + (input.offset?.y ?? 0);
      destination.children.push(copied);
      clones.push(copied);
    }
    this.store.record(
      file,
      "clone",
      clones.map((node) => node.id),
      input.dryRun,
    );
    return clone(clones);
  }

  async deleteNodes(input: DeleteNodesInput): Promise<string[]> {
    const file = this.store.workingFile(input.fileKey, input.dryRun);
    const nodes = input.nodeIds.map((nodeId) =>
      this.store.requireNode(file, nodeId),
    );
    for (const node of nodes) {
      if (!node.parentId) {
        throw new McpFigError(
          "INVALID_ARGUMENT",
          `Root node ${node.id} cannot be deleted.`,
        );
      }
    }
    for (const node of nodes) this.store.removeFromParent(file, node);
    file.selection = file.selection.filter(
      (nodeId) => !input.nodeIds.includes(nodeId),
    );
    this.store.record(file, "delete", input.nodeIds, input.dryRun);
    return [...input.nodeIds];
  }

  countNodes(fileKey?: string): number {
    return countNodes(this.store.requireFile(fileKey).document);
  }
}
