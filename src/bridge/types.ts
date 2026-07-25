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
  componentKey?: string | undefined;
  componentSource?: "local" | "library" | undefined;
  description?: string | undefined;
  componentProperties?: Record<string, ComponentPropertyDefinition> | undefined;
  componentSlots?: Record<string, string[]> | undefined;
  mainComponentId?: string | undefined;
  mainComponentKey?: string | undefined;
  instanceProperties?: Record<string, string | boolean> | undefined;
  boundVariables?: Record<string, string> | undefined;
}

export interface ComponentPropertyDefinition {
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
  defaultValue: string | boolean;
  options?: string[] | undefined;
}

export interface ComponentRecord {
  source: "local" | "library";
  name: string;
  nodeId?: string | undefined;
  key?: string | undefined;
  libraryName?: string | undefined;
  description?: string | undefined;
  properties?: Record<string, ComponentPropertyDefinition> | undefined;
}

export interface VariableMode {
  id: string;
  name: string;
}

export interface VariableCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: VariableMode[];
}

export interface VariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

export type VariableValue = string | number | boolean | VariableAlias;

export interface FigmaVariable {
  id: string;
  key?: string | undefined;
  name: string;
  resolvedType: "BOOLEAN" | "COLOR" | "FLOAT" | "STRING";
  collectionId: string;
  valuesByMode: Record<string, VariableValue>;
}

export interface FigmaFileFixture {
  key: string;
  name: string;
  document: FigmaNode;
  selection?: string[];
  libraryComponents?: ComponentRecord[];
  variableCollections?: VariableCollection[];
  variables?: FigmaVariable[];
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

export type ComponentActionInput =
  | { action: "search"; query?: string; fileKey?: string }
  | {
      action: "inspect";
      componentId?: string;
      componentKey?: string;
      fileKey?: string;
    }
  | { action: "library_search"; query?: string; fileKey?: string }
  | {
      action: "library_inspect";
      componentKey: string;
      fileKey?: string;
    }
  | {
      action: "create_set";
      parentId: string;
      name: string;
      axes: Record<string, string[]>;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "arrange_set";
      componentSetId: string;
      columns?: number;
      gap?: number;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "set_description";
      componentId: string;
      description: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "property_add";
      componentId: string;
      propertyName: string;
      property: ComponentPropertyDefinition;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "property_update";
      componentId: string;
      propertyName: string;
      patch: Partial<ComponentPropertyDefinition>;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "property_delete";
      componentId: string;
      propertyName: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | { action: "slots"; componentId: string; fileKey?: string }
  | {
      action: "slot_create";
      componentId: string;
      slotName: string;
      allowedComponentKeys?: string[];
      dryRun?: boolean;
      fileKey?: string;
    };

export type InstanceActionInput =
  | {
      action: "create";
      componentId?: string;
      componentKey?: string;
      parentId: string;
      properties?: Record<string, string | boolean>;
      x?: number;
      y?: number;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "update";
      instanceIds: string[];
      properties: Record<string, string | boolean>;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "slot_append";
      instanceId: string;
      slotName: string;
      componentKey: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "slot_reset";
      instanceId: string;
      slotName: string;
      dryRun?: boolean;
      fileKey?: string;
    };

export type TokenOperation =
  | { op: "bind"; nodeIds: string[]; field: string; variableId: string }
  | {
      op: "set_value";
      variableId: string;
      modeId: string;
      value: VariableValue;
    }
  | {
      op: "alias";
      variableId: string;
      modeId: string;
      targetVariableId: string;
    }
  | {
      op: "mode_add";
      collectionId: string;
      modeId?: string;
      name: string;
    }
  | {
      op: "mode_rename";
      collectionId: string;
      modeId: string;
      name: string;
    };

export type TokenActionInput =
  | { action: "inspect"; fileKey?: string }
  | {
      action: "apply";
      operations: TokenOperation[];
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "collection_create";
      name: string;
      initialModeName?: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "collection_delete";
      collectionId: string;
      dryRun?: boolean;
      fileKey?: string;
    };

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
  component(input: ComponentActionInput): Promise<Record<string, unknown>>;
  instance(input: InstanceActionInput): Promise<Record<string, unknown>>;
  tokens(input: TokenActionInput): Promise<Record<string, unknown>>;
}
