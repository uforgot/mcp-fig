import { McpFigError } from "../errors.js";
import { InMemoryCore } from "./in-memory/core.js";
import { InMemoryDesignSystem } from "./in-memory/design-system.js";
import { InMemoryLayout } from "./in-memory/layout.js";
import { InMemoryStore } from "./in-memory/store.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  ComponentActionInput,
  CreateNodeInput,
  DeleteNodesInput,
  ExportNodesInput,
  FigmaBridge,
  FigmaFileFixture,
  FigmaFileSummary,
  FigmaNode,
  InstanceActionInput,
  LayoutActionInput,
  MoveNodesInput,
  NodeExportPayload,
  NodeQueryResult,
  QueryNodesInput,
  ResizeNodesInput,
  StyleActionInput,
  TokenActionInput,
  UpdateNodesInput,
} from "./types.js";

export class InMemoryFigmaBridge implements FigmaBridge {
  readonly #core: InMemoryCore;
  readonly #layout: InMemoryLayout;
  readonly #designSystem: InMemoryDesignSystem;

  constructor(fixtures: FigmaFileFixture[], activeFileKey?: string) {
    const store = new InMemoryStore(fixtures, activeFileKey);
    this.#core = new InMemoryCore(store);
    this.#layout = new InMemoryLayout(store);
    this.#designSystem = new InMemoryDesignSystem(store);
  }

  status(): Promise<BridgeStatus> {
    return this.#core.status();
  }
  listFiles(): Promise<FigmaFileSummary[]> {
    return this.#core.listFiles();
  }
  targetFile(fileKey: string): Promise<BridgeStatus> {
    return this.#core.targetFile(fileKey);
  }
  reconnect(): Promise<BridgeStatus> {
    return this.#core.reconnect();
  }
  getDocument(fileKey?: string): Promise<FigmaNode> {
    return this.#core.getDocument(fileKey);
  }
  getSelection(fileKey?: string): Promise<string[]> {
    return this.#core.getSelection(fileKey);
  }
  getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    return this.#core.getChanges(fileKey);
  }
  getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    return this.#core.getNodes(nodeIds, fileKey);
  }
  queryNodes(input: QueryNodesInput): Promise<NodeQueryResult> {
    return this.#core.queryNodes(input);
  }
  createNode(input: CreateNodeInput): Promise<FigmaNode[]> {
    return this.#core.createNode(input);
  }
  updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]> {
    return this.#core.updateNodes(input);
  }
  moveNodes(input: MoveNodesInput): Promise<FigmaNode[]> {
    return this.#core.moveNodes(input);
  }
  resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]> {
    return this.#core.resizeNodes(input);
  }
  cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]> {
    return this.#core.cloneNodes(input);
  }
  deleteNodes(input: DeleteNodesInput): Promise<string[]> {
    return this.#core.deleteNodes(input);
  }
  async exportNodes(_input: ExportNodesInput): Promise<NodeExportPayload[]> {
    throw new McpFigError(
      "UNSUPPORTED_BY_BRIDGE",
      "node.export requires the Desktop Plugin bridge.",
    );
  }
  layout(input: LayoutActionInput): Promise<Record<string, unknown>> {
    return this.#layout.layout(input);
  }
  component(input: ComponentActionInput): Promise<Record<string, unknown>> {
    return this.#designSystem.component(input);
  }
  instance(input: InstanceActionInput): Promise<Record<string, unknown>> {
    return this.#designSystem.instance(input);
  }
  tokens(input: TokenActionInput): Promise<Record<string, unknown>> {
    return this.#designSystem.tokens(input);
  }
  styles(input: StyleActionInput): Promise<Record<string, unknown>> {
    return this.#designSystem.styles(input);
  }
  countNodes(fileKey?: string): number {
    return this.#core.countNodes(fileKey);
  }
}
