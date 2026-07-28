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
  "COMPONENT_SET",
  "INSTANCE",
  "SLOT",
] as const;

export const FIGMA_CREATABLE_NODE_TYPES = [
  "FRAME",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "TEXT",
  "COMPONENT",
] as const;

export type FigmaNodeType = (typeof FIGMA_NODE_TYPES)[number];
export type FigmaCreatableNodeType =
  (typeof FIGMA_CREATABLE_NODE_TYPES)[number];

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface RgbaColor extends RgbColor {
  a: number;
}

export type BlendMode =
  | "PASS_THROUGH"
  | "NORMAL"
  | "DARKEN"
  | "MULTIPLY"
  | "LINEAR_BURN"
  | "COLOR_BURN"
  | "LIGHTEN"
  | "SCREEN"
  | "LINEAR_DODGE"
  | "COLOR_DODGE"
  | "OVERLAY"
  | "SOFT_LIGHT"
  | "HARD_LIGHT"
  | "DIFFERENCE"
  | "EXCLUSION"
  | "HUE"
  | "SATURATION"
  | "COLOR"
  | "LUMINOSITY";

export interface SolidPaint {
  type: "SOLID";
  color: RgbColor;
  boundVariables?: { color?: VariableAlias | undefined } | undefined;
  opacity?: number | undefined;
  visible?: boolean | undefined;
  blendMode?: BlendMode | undefined;
}

export interface GradientPaint {
  type:
    | "GRADIENT_LINEAR"
    | "GRADIENT_RADIAL"
    | "GRADIENT_ANGULAR"
    | "GRADIENT_DIAMOND";
  gradientTransform: [[number, number, number], [number, number, number]];
  gradientStops: { position: number; color: RgbaColor }[];
  opacity?: number | undefined;
  visible?: boolean | undefined;
  blendMode?: BlendMode | undefined;
}

export type FigmaPaint = SolidPaint | GradientPaint;

export type FigmaEffect =
  | {
      type: "DROP_SHADOW" | "INNER_SHADOW";
      color: RgbaColor;
      offset: { x: number; y: number };
      radius: number;
      spread?: number | undefined;
      visible: boolean;
      blendMode: BlendMode;
    }
  | {
      type: "LAYER_BLUR" | "BACKGROUND_BLUR";
      radius: number;
      visible: boolean;
      blurType: "NORMAL";
    };

export interface MixedValue {
  mixed: true;
}

export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}
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
  fills?: (FigmaPaint | Record<string, unknown>)[] | MixedValue | undefined;
  strokes?: (FigmaPaint | Record<string, unknown>)[] | MixedValue | undefined;
  opacity?: number | MixedValue | undefined;
  cornerRadius?: number | MixedValue | undefined;
  cornerRadii?: CornerRadii | undefined;
  effects?: FigmaEffect[] | MixedValue | undefined;
  blendMode?: BlendMode | MixedValue | undefined;
  children?: FigmaNode[] | undefined;
  componentKey?: string | undefined;
  componentSource?: "local" | "library" | undefined;
  description?: string | undefined;
  componentProperties?: Record<string, ComponentPropertyDefinition> | undefined;
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
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "SLOT";
  defaultValue: string | boolean;
  options?: string[] | undefined;
  description?: string | undefined;
  slotSettings?:
    | {
        stretchChildOnInsert?: boolean;
        displayEmptyByDefault?: boolean;
        minChildren?: number | null;
        maxChildren?: number | null;
        allowPreferredValuesOnly?: boolean;
      }
    | undefined;
}

export interface ComponentRecord {
  source: "local" | "library";
  kind?: "COMPONENT" | "COMPONENT_SET" | undefined;
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

export type VariableValue =
  | string
  | number
  | boolean
  | RgbaColor
  | VariableAlias;

export interface FigmaVariable {
  id: string;
  key?: string | undefined;
  name: string;
  description?: string | undefined;
  resolvedType: "BOOLEAN" | "COLOR" | "FLOAT" | "STRING";
  collectionId: string;
  valuesByMode: Record<string, VariableValue>;
}

export type FigmaStyleKind = "PAINT" | "TEXT" | "EFFECT" | "GRID";

export type FigmaLayoutGrid =
  | {
      pattern: "GRID";
      sectionSize: number;
      visible?: boolean | undefined;
      color?: RgbaColor | undefined;
    }
  | {
      pattern: "COLUMNS" | "ROWS";
      alignment: "MIN" | "MAX" | "CENTER" | "STRETCH";
      gutterSize: number;
      count: number;
      offset: number;
      visible?: boolean | undefined;
      color?: RgbaColor | undefined;
    };

export interface FigmaTextStyleProperties {
  fontName: FontName;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  paragraphIndent?: number | undefined;
  paragraphSpacing?: number | undefined;
  textCase?:
    | "ORIGINAL"
    | "UPPER"
    | "LOWER"
    | "TITLE"
    | "SMALL_CAPS"
    | "SMALL_CAPS_FORCED"
    | undefined;
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH" | undefined;
}

export type FigmaStylePaint = FigmaPaint extends infer Paint
  ? Paint extends FigmaPaint
    ? Omit<Paint, "boundVariables">
    : never
  : never;

export type FigmaStyleRecord =
  | {
      source: "local" | "library";
      kind: "PAINT";
      id: string;
      key?: string | undefined;
      name: string;
      description?: string | undefined;
      paints: FigmaStylePaint[];
    }
  | {
      source: "local" | "library";
      kind: "TEXT";
      id: string;
      key?: string | undefined;
      name: string;
      description?: string | undefined;
      text: FigmaTextStyleProperties;
    }
  | {
      source: "local" | "library";
      kind: "EFFECT";
      id: string;
      key?: string | undefined;
      name: string;
      description?: string | undefined;
      effects: FigmaEffect[];
    }
  | {
      source: "local" | "library";
      kind: "GRID";
      id: string;
      key?: string | undefined;
      name: string;
      description?: string | undefined;
      grids: FigmaLayoutGrid[];
    };

export type FigmaStyleWrite = FigmaStyleRecord extends infer Style
  ? Style extends FigmaStyleRecord
    ? Omit<Style, "id" | "key" | "source">
    : never
  : never;

export type StyleActionInput = AddWriteControl<
  | {
      action: "inspect";
      kind?: FigmaStyleKind;
      styleIds?: string[];
      fileKey?: string;
    }
  | {
      action: "create";
      style: FigmaStyleWrite;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "update";
      styleId: string;
      style: FigmaStyleWrite;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "delete";
      styleId: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "library_import";
      styleKey: string;
      dryRun?: boolean;
      fileKey?: string;
    },
  "inspect"
>;

export interface FigmaFileFixture {
  key: string;
  name: string;
  document: FigmaNode;
  selection?: string[];
  libraryComponents?: ComponentRecord[];
  variableCollections?: VariableCollection[];
  variables?: FigmaVariable[];
  styles?: FigmaStyleRecord[];
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
  fills?: FigmaPaint[] | undefined;
  strokes?: FigmaPaint[] | undefined;
  opacity?: number | undefined;
  cornerRadius?: number | undefined;
  effects?: FigmaEffect[] | undefined;
  blendMode?: BlendMode | undefined;
  constraints?: LayoutConstraints | undefined;
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
  nodeType: FigmaCreatableNodeType;
  name?: string;
  props?: NodeProps;
}

export interface UpdateNodesInput extends MutationOptions {
  nodeIds: string[];
  patch: NodePatch;
}

export interface QueryNodesInput {
  fileKey?: string;
  rootId?: string;
  name?: string;
  nameMatch?: "exact" | "contains";
  caseSensitive?: boolean;
  nodeType?: FigmaNodeType;
  path?: string[];
  maxDepth: number;
  limit: number;
}

export interface NodeQueryMatch {
  node: FigmaNode;
  path: string[];
}

export interface NodeQueryResult {
  matches: NodeQueryMatch[];
  limit: number;
  truncated: boolean;
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

export type NodeExportFormat = "PNG" | "JPG" | "SVG" | "PDF";

export interface ExportNodesInput {
  nodeIds: string[];
  format: NodeExportFormat;
  scale?: number;
  fileKey?: string;
}

export interface NodeExportPayload {
  nodeId: string;
  nodeName: string;
  format: NodeExportFormat;
  mimeType: string;
  byteLength: number;
  dataBase64: string;
}

export type ScreenshotScope = "viewport" | "selection" | "node";
export type VisualAuditCategory =
  | "accessibility"
  | "design_system"
  | "layout"
  | "lint";

export interface ScreenshotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotPreparation {
  fileName: string;
  pageId: string;
  scope: ScreenshotScope;
  focusNodeIds: string[];
  viewportBounds: ScreenshotBounds;
  focusBounds?: ScreenshotBounds | undefined;
  leaseId: string;
}

export type VisualActionInput =
  | {
      action: "prepare_capture";
      scope: ScreenshotScope;
      nodeIds?: string[];
      focus?: boolean;
      fileKey?: string;
    }
  | {
      action: "release_capture";
      leaseId: string;
      fileKey?: string;
    }
  | {
      action: "audit";
      rootNodeIds: string[];
      categories: VisualAuditCategory[];
      maxDepth: number;
      maxNodes: number;
      maxIssues: number;
      fileKey?: string;
    };

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
      action: "library_import";
      componentKey: string;
      kind: "COMPONENT" | "COMPONENT_SET";
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
      description?: string;
      slotSettings?: ComponentPropertyDefinition["slotSettings"];
      dryRun?: boolean;
      fileKey?: string;
    };

export type ComponentActionInput = AddWriteControl<
  ComponentAction,
  "search" | "inspect" | "library_search" | "library_inspect" | "slots"
>;

type InstanceAction =
  | {
      action: "inspect";
      instanceIds: string[];
      fileKey?: string;
    }
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
      action: "swap";
      instanceIds: string[];
      componentId?: string;
      componentKey?: string;
      preserveOverrides?: boolean;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "reset";
      instanceIds: string[];
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

export type InstanceActionInput = AddWriteControl<InstanceAction, "inspect">;

export type TokenOperation =
  | { op: "bind"; nodeIds: string[]; field: string; variableId: string }
  | { op: "unbind"; nodeIds: string[]; field: string }
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
    }
  | {
      op: "mode_remove";
      collectionId: string;
      modeId: string;
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
      action: "library_import";
      variableKey: string;
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
      action: "collection_update";
      collectionId: string;
      name: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "variable_create";
      collectionId: string;
      name: string;
      resolvedType: FigmaVariable["resolvedType"];
      description?: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "variable_update";
      variableId: string;
      name?: string;
      description?: string;
      dryRun?: boolean;
      fileKey?: string;
    }
  | {
      action: "variable_delete";
      variableId: string;
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

export interface TextRangeStyle {
  fontName?: FontName;
  fontSize?: number;
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  fills?: FigmaPaint[];
}

export interface TextRangeActionInput extends MutationOptions {
  action: "read" | "update";
  nodeId: string;
  start?: number;
  end?: number;
  ranges?: { start: number; end: number; style: TextRangeStyle }[];
}

export interface ImageMetadata {
  hash: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif";
  byteLength: number;
  width: number;
  height: number;
}

export type ImageActionInput =
  | ({
      action: "import";
      dataBase64: string;
      mimeType: ImageMetadata["mimeType"];
    } & MutationOptions)
  | { action: "inspect"; hash: string; fileKey?: string }
  | ({
      action: "fill";
      nodeIds: string[];
      hash: string;
      operation: "append" | "replace";
      index?: number;
      scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
    } & MutationOptions);

export interface FigmaComment {
  id: string;
  message: string;
  createdAt: string;
  resolvedAt: string | null;
  user: {
    id?: string;
    handle?: string;
    imgUrl?: string;
  };
  nodeId?: string;
  nodeOffset?: { x: number; y: number };
  parentId?: string;
  orderId?: string;
}

export interface FigmaBridge {
  close?(): Promise<void> | void;
  textRange?(input: TextRangeActionInput): Promise<Record<string, unknown>>;
  image?(input: ImageActionInput): Promise<Record<string, unknown>>;
  status(): Promise<BridgeStatus>;
  listFiles(): Promise<FigmaFileSummary[]>;
  targetFile(fileKey: string): Promise<BridgeStatus>;
  reconnect(): Promise<BridgeStatus>;
  getDocument(fileKey?: string): Promise<FigmaNode>;
  getDocumentSummary?(fileKey?: string): Promise<FigmaDocumentSummary>;
  getSelection(fileKey?: string): Promise<string[]>;
  getChanges(fileKey?: string): Promise<ChangeRecord[]>;
  getComments?(fileKey?: string): Promise<FigmaComment[]>;
  getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]>;
  queryNodes(input: QueryNodesInput): Promise<NodeQueryResult>;
  createNode(input: CreateNodeInput): Promise<FigmaNode[]>;
  updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]>;
  moveNodes(input: MoveNodesInput): Promise<FigmaNode[]>;
  resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]>;
  cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]>;
  deleteNodes(input: DeleteNodesInput): Promise<string[]>;
  exportNodes(input: ExportNodesInput): Promise<NodeExportPayload[]>;
  layout(input: LayoutActionInput): Promise<Record<string, unknown>>;
  component(input: ComponentActionInput): Promise<Record<string, unknown>>;
  instance(input: InstanceActionInput): Promise<Record<string, unknown>>;
  tokens(input: TokenActionInput): Promise<Record<string, unknown>>;
  styles(input: StyleActionInput): Promise<Record<string, unknown>>;
  visual(input: VisualActionInput): Promise<Record<string, unknown>>;
}
