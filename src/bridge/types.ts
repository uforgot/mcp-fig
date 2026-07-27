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
  fontName?: FontName | undefined;
  fontSize?: number | undefined;
  lineHeight?: LineHeight | undefined;
  letterSpacing?: LetterSpacing | undefined;
  textAlignHorizontal?: TextAlignHorizontal | undefined;
  textAlignVertical?: TextAlignVertical | undefined;
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
  layoutMode?: LayoutMode | undefined;
  itemSpacing?: number | undefined;
  paddingTop?: number | undefined;
  paddingRight?: number | undefined;
  paddingBottom?: number | undefined;
  paddingLeft?: number | undefined;
  primaryAxisAlignItems?: PrimaryAxisAlignment | undefined;
  counterAxisAlignItems?: CounterAxisAlignment | undefined;
  layoutWrap?: LayoutWrap | undefined;
  primaryAxisSizingMode?: AxisSizingMode | undefined;
  counterAxisSizingMode?: AxisSizingMode | undefined;
  layoutSizingHorizontal?: LayoutSizing | undefined;
  layoutSizingVertical?: LayoutSizing | undefined;
  minWidth?: number | undefined;
  maxWidth?: number | undefined;
  minHeight?: number | undefined;
  maxHeight?: number | undefined;
  layoutAlign?: "INHERIT" | "STRETCH" | undefined;
  layoutPositioning?: "AUTO" | "ABSOLUTE" | undefined;
  constraints?: LayoutConstraints | undefined;
  source?: "rest" | undefined;
  revision?: string | undefined;
  freshnessWarning?: string | undefined;
}

export interface FontName {
  family: string;
  style: string;
}

export type LineHeight =
  | { unit: "AUTO" }
  | { unit: "PIXELS" | "PERCENT"; value: number };

export interface LetterSpacing {
  unit: "PIXELS" | "PERCENT";
  value: number;
}

export type TextAlignHorizontal = "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
export type TextAlignVertical = "TOP" | "CENTER" | "BOTTOM";

export type LayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL";
export type LayoutWrap = "NO_WRAP" | "WRAP";
export type PrimaryAxisAlignment = "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
export type CounterAxisAlignment = "MIN" | "CENTER" | "MAX" | "BASELINE";
export type AxisSizingMode = "FIXED" | "AUTO";
export type LayoutSizing = "FIXED" | "HUG" | "FILL";
export type HorizontalConstraint =
  | "LEFT"
  | "RIGHT"
  | "CENTER"
  | "LEFT_RIGHT"
  | "SCALE";
export type VerticalConstraint =
  | "TOP"
  | "BOTTOM"
  | "CENTER"
  | "TOP_BOTTOM"
  | "SCALE";

export interface LayoutConstraints {
  horizontal: HorizontalConstraint;
  vertical: VerticalConstraint;
}

export interface LayoutConfig {
  layoutMode: Exclude<LayoutMode, "NONE">;
  gap?: number;
  itemSpacing?: number;
  padding?:
    | number
    | { top: number; right: number; bottom: number; left: number };
  primaryAxisAlignItems?: PrimaryAxisAlignment;
  counterAxisAlignItems?: CounterAxisAlignment;
  layoutWrap?: LayoutWrap;
  primaryAxisSizingMode?: AxisSizingMode;
  counterAxisSizingMode?: AxisSizingMode;
}

export interface LayoutSizingConfig {
  horizontal: LayoutSizing;
  vertical: LayoutSizing;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  layoutAlign?: "INHERIT" | "STRETCH";
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

export interface FigmaDocumentSummary {
  document: Pick<FigmaNode, "id" | "name" | "type">;
  nodeCount: number;
  byType: Record<string, number>;
}

export interface BridgeStatus {
  connected: boolean;
  connectionState?:
    | "disconnected"
    | "connecting"
    | "paired"
    | "ready"
    | "degraded"
    | "reconnecting";
  lastHeartbeatAt?: string;
  mode: BridgeMode;
  fileKey?: string;
  fileName?: string;
  revision?: string;
  readSource: "none" | "fixture" | "rest" | "desktop-plugin";
  writeSource: "none" | "fixture" | "desktop-plugin";
  pluginConnected?: boolean;
  restAvailable?: boolean;
  degradedReason?: string;
  freshnessWarning?: string;
}

export interface ChangeRecord {
  revision: string;
  action: string;
  nodeIds: string[];
  timestamp: string;
  source?: "rest" | undefined;
  freshnessWarning?: string | undefined;
}

export interface NodeProps {
  x?: number | undefined;
  y?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  visible?: boolean | undefined;
  locked?: boolean | undefined;
  text?: string | undefined;
  fontName?: FontName | undefined;
  fontSize?: number | undefined;
  lineHeight?: LineHeight | undefined;
  letterSpacing?: LetterSpacing | undefined;
  textAlignHorizontal?: TextAlignHorizontal | undefined;
  textAlignVertical?: TextAlignVertical | undefined;
  fills?: Record<string, unknown>[] | undefined;
  strokes?: Record<string, unknown>[] | undefined;
}

export interface NodePatch extends NodeProps {
  name?: string | undefined;
}

export interface MutationOptions {
  fileKey?: string;
  dryRun?: boolean;
  expectedRevision?: string;
  idempotencyKey?: string;
}

type WriteControl = Pick<
  MutationOptions,
  "expectedRevision" | "idempotencyKey"
>;
type AddWriteControl<Input, ReadAction extends string> = Input extends {
  action: infer Action;
}
  ? Action extends ReadAction
    ? Input
    : Input & WriteControl
  : Input;

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

export type LayoutOperation =
  | { op: "apply"; nodeIds: string[]; layout: LayoutConfig }
  | { op: "sizing"; nodeIds: string[]; sizing: LayoutSizingConfig }
  | {
      op: "constraints";
      nodeIds: string[];
      constraints: LayoutConstraints;
    };

export const LAYOUT_ISSUE_CODES = [
  "AUTO_LAYOUT_OVERFLOW_HORIZONTAL",
  "AUTO_LAYOUT_OVERFLOW_VERTICAL",
  "FILL_IN_HUG_PARENT_HORIZONTAL",
  "FILL_IN_HUG_PARENT_VERTICAL",
  "HUG_WITHOUT_AUTO_LAYOUT_PARENT",
  "FILL_WITHOUT_AUTO_LAYOUT_PARENT",
  "MIN_MAX_CONFLICT_WIDTH",
  "MIN_MAX_CONFLICT_HEIGHT",
] as const;

export type LayoutIssueCode = (typeof LAYOUT_ISSUE_CODES)[number];

export interface LayoutIssue {
  code: LayoutIssueCode;
  nodeId: string;
  message: string;
  repairable: boolean;
  axis?: "horizontal" | "vertical";
  details: Record<string, unknown>;
}

export interface LayoutRepairChange {
  property: "layoutSizingHorizontal" | "layoutSizingVertical";
  from: LayoutSizing;
  to: "FIXED";
}

export interface LayoutRepair {
  issueCode: LayoutIssueCode;
  nodeId: string;
  reason: string;
  changes: LayoutRepairChange[];
}

type LayoutAction =
  | { action: "inspect"; nodeIds: string[]; fileKey?: string }
  | {
      action: "apply";
      nodeIds: string[];
      layout: LayoutConfig;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "sizing";
      nodeIds: string[];
      sizing: LayoutSizingConfig;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "batch";
      operations: LayoutOperation[];
      dryRun?: boolean;
      fileKey?: string;
    }
  | { action: "validate"; nodeIds: string[]; fileKey?: string }
  | {
      action: "repair";
      nodeIds: string[];
      issueCodes: LayoutIssueCode[];
      dryRun?: boolean;
      fileKey?: string;
    };

export type LayoutActionInput = AddWriteControl<
  LayoutAction,
  "inspect" | "validate"
>;

export interface LayoutSnapshot {
  nodeId: string;
  name: string;
  parentId?: string;
  childIds: string[];
  layout: {
    layoutMode: LayoutMode;
    gap: number;
    itemSpacing: number;
    padding: { top: number; right: number; bottom: number; left: number };
    primaryAxisAlignItems: PrimaryAxisAlignment;
    counterAxisAlignItems: CounterAxisAlignment;
    layoutWrap: LayoutWrap;
    primaryAxisSizingMode: AxisSizingMode;
    counterAxisSizingMode: AxisSizingMode;
  };
  sizing: {
    horizontal: LayoutSizing;
    vertical: LayoutSizing;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    layoutAlign?: "INHERIT" | "STRETCH";
    layoutPositioning?: "AUTO" | "ABSOLUTE";
  };
  constraints: LayoutConstraints;
}

type ComponentAction =
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

export type ComponentActionInput = AddWriteControl<
  ComponentAction,
  "search" | "inspect" | "library_search" | "library_inspect" | "slots"
>;

type InstanceAction =
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

export type InstanceActionInput = AddWriteControl<InstanceAction, never>;

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

type TokenAction =
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

export type TokenActionInput = AddWriteControl<TokenAction, "inspect">;

export interface FigmaBridge {
  close?(): Promise<void> | void;
  status(): Promise<BridgeStatus>;
  listFiles(): Promise<FigmaFileSummary[]>;
  targetFile(fileKey: string): Promise<BridgeStatus>;
  reconnect(): Promise<BridgeStatus>;
  getDocument(fileKey?: string): Promise<FigmaNode>;
  getDocumentSummary?(fileKey?: string): Promise<FigmaDocumentSummary>;
  getSelection(fileKey?: string): Promise<string[]>;
  getChanges(fileKey?: string): Promise<ChangeRecord[]>;
  getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]>;
  createNode(input: CreateNodeInput): Promise<FigmaNode[]>;
  updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]>;
  moveNodes(input: MoveNodesInput): Promise<FigmaNode[]>;
  resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]>;
  cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]>;
  deleteNodes(input: DeleteNodesInput): Promise<string[]>;
  layout(input: LayoutActionInput): Promise<Record<string, unknown>>;
  component(input: ComponentActionInput): Promise<Record<string, unknown>>;
  instance(input: InstanceActionInput): Promise<Record<string, unknown>>;
  tokens(input: TokenActionInput): Promise<Record<string, unknown>>;
}
