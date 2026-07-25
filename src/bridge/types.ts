export const FIGMA_NODE_TYPES = [
  "DOCUMENT",
  "PAGE",
  "FRAME",
  "GROUP",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "TEXT",
  "COMPONENT",
  "INSTANCE",
] as const;

export type FigmaNodeType = (typeof FIGMA_NODE_TYPES)[number];
export type BridgeMode =
  | "disconnected"
  | "fixture"
  | "rest"
  | "desktop-plugin"
  | "hybrid";

export interface FigmaNode {
  id: string;
  type: string;
  name: string;
  parentId?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  visible?: boolean | undefined;
  locked?: boolean | undefined;
  text?: string | undefined;
  fills?: Record<string, unknown>[] | undefined;
  strokes?: Record<string, unknown>[] | undefined;
  children?: FigmaNode[] | undefined;
}

export interface FigmaFileFixture {
  key: string;
  name: string;
  document: FigmaNode;
  selection?: string[];
}

export interface FigmaFileSummary {
  key: string;
  name: string;
  revision: string;
}

export interface BridgeStatus {
  connected: boolean;
  mode: BridgeMode;
  fileKey?: string;
  fileName?: string;
  revision?: string;
  readSource: "none" | "fixture" | "rest" | "desktop-plugin";
  writeSource: "none" | "fixture" | "desktop-plugin";
}

export interface ChangeRecord {
  revision: string;
  action: string;
  nodeIds: string[];
  timestamp: string;
}

export interface NodeProps {
  x?: number | undefined;
  y?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  visible?: boolean | undefined;
  locked?: boolean | undefined;
  text?: string | undefined;
  fills?: Record<string, unknown>[] | undefined;
  strokes?: Record<string, unknown>[] | undefined;
}

export interface NodePatch extends NodeProps {
  name?: string | undefined;
}

export interface MutationOptions {
  fileKey?: string;
  dryRun?: boolean;
}

export interface CreateNodeInput extends MutationOptions {
  parentId: string;
  nodeType: FigmaNodeType;
  name?: string;
  props?: NodeProps;
}

export interface UpdateNodesInput extends MutationOptions {
  nodeIds: string[];
  patch: NodePatch;
}

export interface MoveNodesInput extends MutationOptions {
  nodeIds: string[];
  parentId?: string;
  index?: number;
  x?: number;
  y?: number;
}

export interface ResizeNodesInput extends MutationOptions {
  nodeIds: string[];
  size: { width: number; height: number };
}

export interface CloneNodesInput extends MutationOptions {
  nodeIds: string[];
  parentId?: string;
  offset?: { x: number; y: number };
}

export interface DeleteNodesInput extends MutationOptions {
  nodeIds: string[];
}

export interface FigmaBridge {
  status(): Promise<BridgeStatus>;
  listFiles(): Promise<FigmaFileSummary[]>;
  targetFile(fileKey: string): Promise<BridgeStatus>;
  reconnect(): Promise<BridgeStatus>;
  getDocument(fileKey?: string): Promise<FigmaNode>;
  getSelection(fileKey?: string): Promise<string[]>;
  getChanges(fileKey?: string): Promise<ChangeRecord[]>;
  getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]>;
  createNode(input: CreateNodeInput): Promise<FigmaNode[]>;
  updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]>;
  moveNodes(input: MoveNodesInput): Promise<FigmaNode[]>;
  resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]>;
  cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]>;
  deleteNodes(input: DeleteNodesInput): Promise<string[]>;
}
