import { McpFigError } from "../errors.js";
import { inspectLayoutNode, validateLayoutScope } from "./layout.js";
import { querySerializedNodes } from "./node-query.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  ComponentActionInput,
  ComponentRecord,
  CreateNodeInput,
  DeleteNodesInput,
  ExportNodesInput,
  FigmaBridge,
  FigmaEffect,
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
  VisualActionInput,
} from "./types.js";

export const REST_FRESHNESS_WARNING =
  "REST data can lag unsaved local Figma state; do not compare its revision with Plugin revisions.";

export interface RestBridgeOptions {
  accessToken?: string;
  loadAccessToken?: () => Promise<string | undefined>;
  fileKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface RestFileResponse {
  name: string;
  version?: string;
  document: Record<string, unknown>;
}

function unsupported(action: string): never {
  throw new McpFigError(
    "UNSUPPORTED_BY_BRIDGE",
    `${action} requires the Figma Desktop Plugin bridge; REST is read-only.`,
    { details: { bridge: "rest", action } },
  );
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toPaints(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(toRecord).filter((paint) => paint !== undefined);
}

function toEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | undefined {
  return typeof value === "string" && values.includes(value)
    ? value
    : undefined;
}

const BLEND_MODES = [
  "PASS_THROUGH",
  "NORMAL",
  "DARKEN",
  "MULTIPLY",
  "LINEAR_BURN",
  "COLOR_BURN",
  "LIGHTEN",
  "SCREEN",
  "LINEAR_DODGE",
  "COLOR_DODGE",
  "OVERLAY",
  "SOFT_LIGHT",
  "HARD_LIGHT",
  "DIFFERENCE",
  "EXCLUSION",
  "HUE",
  "SATURATION",
  "COLOR",
  "LUMINOSITY",
] as const;

function toEffects(value: unknown): FigmaEffect[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const effects: FigmaEffect[] = [];
  for (const item of value) {
    const effect = toRecord(item);
    if (!effect) continue;
    const type = toEnum(effect.type, [
      "DROP_SHADOW",
      "INNER_SHADOW",
      "LAYER_BLUR",
      "BACKGROUND_BLUR",
    ] as const);
    if (!type || typeof effect.radius !== "number") continue;
    if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
      effects.push({
        type,
        radius: effect.radius,
        visible: effect.visible !== false,
        blurType: "NORMAL",
      });
      continue;
    }
    const color = toRecord(effect.color);
    const offset = toRecord(effect.offset);
    const blendMode = toEnum(effect.blendMode, BLEND_MODES) ?? "NORMAL";
    if (
      typeof color?.r !== "number" ||
      typeof color.g !== "number" ||
      typeof color.b !== "number" ||
      typeof color.a !== "number" ||
      typeof offset?.x !== "number" ||
      typeof offset.y !== "number"
    )
      continue;
    effects.push({
      type,
      color: { r: color.r, g: color.g, b: color.b, a: color.a },
      offset: { x: offset.x, y: offset.y },
      radius: effect.radius,
      ...(typeof effect.spread === "number" ? { spread: effect.spread } : {}),
      visible: effect.visible !== false,
      blendMode,
    });
  }
  return effects;
}

function toNode(raw: Record<string, unknown>, parentId?: string): FigmaNode {
  const box = toRecord(raw.absoluteBoundingBox);
  const id = typeof raw.id === "string" ? raw.id : "unknown";
  const type = typeof raw.type === "string" ? raw.type : "UNKNOWN";
  const children = Array.isArray(raw.children)
    ? raw.children
        .map(toRecord)
        .filter((child) => child !== undefined)
        .map((child) => toNode(child, id))
    : undefined;
  const layoutMode = toEnum(raw.layoutMode, [
    "NONE",
    "HORIZONTAL",
    "VERTICAL",
  ] as const);
  const primaryAxisAlignItems = toEnum(raw.primaryAxisAlignItems, [
    "MIN",
    "CENTER",
    "MAX",
    "SPACE_BETWEEN",
  ] as const);
  const counterAxisAlignItems = toEnum(raw.counterAxisAlignItems, [
    "MIN",
    "CENTER",
    "MAX",
    "BASELINE",
  ] as const);
  const layoutWrap = toEnum(raw.layoutWrap, ["NO_WRAP", "WRAP"] as const);
  const primaryAxisSizingMode = toEnum(raw.primaryAxisSizingMode, [
    "FIXED",
    "AUTO",
  ] as const);
  const counterAxisSizingMode = toEnum(raw.counterAxisSizingMode, [
    "FIXED",
    "AUTO",
  ] as const);
  const layoutSizingHorizontal = toEnum(raw.layoutSizingHorizontal, [
    "FIXED",
    "HUG",
    "FILL",
  ] as const);
  const layoutSizingVertical = toEnum(raw.layoutSizingVertical, [
    "FIXED",
    "HUG",
    "FILL",
  ] as const);
  const layoutAlign = toEnum(raw.layoutAlign, ["INHERIT", "STRETCH"] as const);
  const layoutPositioning = toEnum(raw.layoutPositioning, [
    "AUTO",
    "ABSOLUTE",
  ] as const);
  const rawConstraints = toRecord(raw.constraints);
  const horizontalConstraint = toEnum(rawConstraints?.horizontal, [
    "LEFT",
    "RIGHT",
    "CENTER",
    "LEFT_RIGHT",
    "SCALE",
  ] as const);
  const verticalConstraint = toEnum(rawConstraints?.vertical, [
    "TOP",
    "BOTTOM",
    "CENTER",
    "TOP_BOTTOM",
    "SCALE",
  ] as const);
  const blendMode = toEnum(raw.blendMode, BLEND_MODES);
  const effects = toEffects(raw.effects);
  const radii = Array.isArray(raw.rectangleCornerRadii)
    ? raw.rectangleCornerRadii
    : undefined;
  const cornerRadii =
    radii?.length === 4 && radii.every((radius) => typeof radius === "number")
      ? {
          topLeft: radii[0] as number,
          topRight: radii[1] as number,
          bottomRight: radii[2] as number,
          bottomLeft: radii[3] as number,
        }
      : undefined;
  return {
    id,
    type,
    name: typeof raw.name === "string" ? raw.name : type.toLowerCase(),
    ...(parentId ? { parentId } : {}),
    ...(typeof box?.x === "number" ? { x: box.x } : {}),
    ...(typeof box?.y === "number" ? { y: box.y } : {}),
    ...(typeof box?.width === "number" ? { width: box.width } : {}),
    ...(typeof box?.height === "number" ? { height: box.height } : {}),
    ...(typeof raw.visible === "boolean" ? { visible: raw.visible } : {}),
    ...(typeof raw.locked === "boolean" ? { locked: raw.locked } : {}),
    ...(typeof raw.characters === "string" ? { text: raw.characters } : {}),
    ...(toPaints(raw.fills) ? { fills: toPaints(raw.fills) } : {}),
    ...(toPaints(raw.strokes) ? { strokes: toPaints(raw.strokes) } : {}),
    ...(typeof raw.opacity === "number" ? { opacity: raw.opacity } : {}),
    ...(typeof raw.cornerRadius === "number"
      ? { cornerRadius: raw.cornerRadius }
      : {}),
    ...(cornerRadii ? { cornerRadii } : {}),
    ...(effects ? { effects } : {}),
    ...(blendMode ? { blendMode } : {}),
    ...(layoutMode ? { layoutMode } : {}),
    ...(typeof raw.itemSpacing === "number"
      ? { itemSpacing: raw.itemSpacing }
      : {}),
    ...(typeof raw.paddingTop === "number"
      ? { paddingTop: raw.paddingTop }
      : {}),
    ...(typeof raw.paddingRight === "number"
      ? { paddingRight: raw.paddingRight }
      : {}),
    ...(typeof raw.paddingBottom === "number"
      ? { paddingBottom: raw.paddingBottom }
      : {}),
    ...(typeof raw.paddingLeft === "number"
      ? { paddingLeft: raw.paddingLeft }
      : {}),
    ...(primaryAxisAlignItems ? { primaryAxisAlignItems } : {}),
    ...(counterAxisAlignItems ? { counterAxisAlignItems } : {}),
    ...(layoutWrap ? { layoutWrap } : {}),
    ...(primaryAxisSizingMode ? { primaryAxisSizingMode } : {}),
    ...(counterAxisSizingMode ? { counterAxisSizingMode } : {}),
    ...(layoutSizingHorizontal ? { layoutSizingHorizontal } : {}),
    ...(layoutSizingVertical ? { layoutSizingVertical } : {}),
    ...(typeof raw.minWidth === "number" ? { minWidth: raw.minWidth } : {}),
    ...(typeof raw.maxWidth === "number" ? { maxWidth: raw.maxWidth } : {}),
    ...(typeof raw.minHeight === "number" ? { minHeight: raw.minHeight } : {}),
    ...(typeof raw.maxHeight === "number" ? { maxHeight: raw.maxHeight } : {}),
    ...(layoutAlign ? { layoutAlign } : {}),
    ...(layoutPositioning ? { layoutPositioning } : {}),
    ...(horizontalConstraint && verticalConstraint
      ? {
          constraints: {
            horizontal: horizontalConstraint,
            vertical: verticalConstraint,
          },
        }
      : {}),
    ...(children ? { children } : {}),
  };
}

function localComponents(root: FigmaNode): ComponentRecord[] {
  const records: ComponentRecord[] = [];
  if (root.type === "COMPONENT" || root.type === "COMPONENT_SET") {
    records.push({
      source: "local",
      nodeId: root.id,
      name: root.name,
      ...(root.componentKey ? { key: root.componentKey } : {}),
      ...(root.description ? { description: root.description } : {}),
      ...(root.componentProperties
        ? { properties: root.componentProperties }
        : {}),
    });
  }
  for (const child of root.children ?? []) {
    records.push(...localComponents(child));
  }
  return records;
}

export class RestFigmaBridge implements FigmaBridge {
  readonly #accessToken: string | undefined;
  readonly #loadAccessToken: (() => Promise<string | undefined>) | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  #activeFileKey: string | undefined;
  #fileName: string | undefined;
  #revision: string | undefined;
  #verified = false;

  constructor(options: RestBridgeOptions) {
    this.#accessToken = options.accessToken;
    this.#loadAccessToken = options.loadAccessToken;
    this.#baseUrl = (options.baseUrl ?? "https://api.figma.com").replace(
      /\/$/,
      "",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error("REST timeout must be a positive integer.");
    }
    if (options.fileKey) this.#activeFileKey = options.fileKey;
  }

  async status(): Promise<BridgeStatus> {
    return {
      connected: this.#verified,
      mode: "rest",
      ...(this.#activeFileKey ? { fileKey: this.#activeFileKey } : {}),
      ...(this.#fileName ? { fileName: this.#fileName } : {}),
      ...(this.#revision ? { revision: this.#revision } : {}),
      readSource: "rest",
      writeSource: "none",
      restAvailable: await this.isAvailable(),
      freshnessWarning: REST_FRESHNESS_WARNING,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this.#accessToken) return true;
    try {
      return Boolean(await this.#loadAccessToken?.());
    } catch {
      return false;
    }
  }

  async listFiles(): Promise<FigmaFileSummary[]> {
    if (!this.#activeFileKey) return [];
    if (!this.#verified) await this.reconnect();
    return [
      {
        key: this.#activeFileKey,
        name: this.#fileName ?? this.#activeFileKey,
        revision: this.#revision ?? "unknown",
      },
    ];
  }

  async targetFile(fileKey: string): Promise<BridgeStatus> {
    this.#activeFileKey = fileKey;
    this.#fileName = undefined;
    this.#revision = undefined;
    this.#verified = false;
    return this.reconnect();
  }

  async reconnect(): Promise<BridgeStatus> {
    await this.#loadFile(this.#requireFileKey());
    return this.status();
  }

  async getDocument(fileKey?: string): Promise<FigmaNode> {
    const response = await this.#loadFile(this.#requireFileKey(fileKey));
    return this.#withMetadata(toNode(response.document));
  }

  async getSelection(_fileKey?: string): Promise<string[]> {
    return unsupported("selection.get");
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    const key = this.#requireFileKey(fileKey);
    if (!this.#revision) await this.#loadFile(key);
    const response = await this.#request<{ versions?: unknown[] }>(
      `/v1/files/${encodeURIComponent(key)}/versions`,
    );
    return (response.versions ?? [])
      .map(toRecord)
      .filter((version) => version !== undefined)
      .map((version) => ({
        revision: String(version.id ?? "unknown"),
        action: "version",
        nodeIds: [],
        timestamp: String(version.created_at ?? new Date(0).toISOString()),
        source: "rest" as const,
        freshnessWarning: REST_FRESHNESS_WARNING,
      }));
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    const key = this.#requireFileKey(fileKey);
    if (!this.#revision) await this.#loadFile(key);
    const query = new URLSearchParams({ ids: nodeIds.join(",") });
    const response = await this.#request<{
      nodes?: Record<string, { document?: Record<string, unknown> } | null>;
    }>(`/v1/files/${encodeURIComponent(key)}/nodes?${query}`);
    const nodes = response.nodes ?? {};
    return nodeIds.map((nodeId) => {
      const document = nodes[nodeId]?.document;
      if (!document) {
        throw new McpFigError(
          "NODE_NOT_FOUND",
          `Figma node ${nodeId} was not found.`,
          { details: { fileKey: key, nodeId } },
        );
      }
      return this.#withMetadata(toNode(document));
    });
  }

  async queryNodes(input: QueryNodesInput): Promise<NodeQueryResult> {
    const root = input.rootId
      ? (await this.getNodes([input.rootId], input.fileKey))[0]
      : await this.getDocument(input.fileKey);
    if (!root) {
      throw new McpFigError(
        "NODE_NOT_FOUND",
        `Figma node ${input.rootId} was not found.`,
      );
    }
    return querySerializedNodes(root, input);
  }

  async createNode(_input: CreateNodeInput): Promise<FigmaNode[]> {
    return unsupported("node.create");
  }

  async updateNodes(_input: UpdateNodesInput): Promise<FigmaNode[]> {
    return unsupported("node.update");
  }

  async moveNodes(_input: MoveNodesInput): Promise<FigmaNode[]> {
    return unsupported("node.move");
  }

  async resizeNodes(_input: ResizeNodesInput): Promise<FigmaNode[]> {
    return unsupported("node.resize");
  }

  async cloneNodes(_input: CloneNodesInput): Promise<FigmaNode[]> {
    return unsupported("node.clone");
  }

  async deleteNodes(_input: DeleteNodesInput): Promise<string[]> {
    return unsupported("node.delete");
  }

  async exportNodes(_input: ExportNodesInput): Promise<NodeExportPayload[]> {
    return unsupported("node.export");
  }

  async layout(input: LayoutActionInput): Promise<Record<string, unknown>> {
    if (input.action === "inspect") {
      return {
        layouts: (await this.getNodes(input.nodeIds, input.fileKey)).map(
          inspectLayoutNode,
        ),
        ...this.#metadata(),
      };
    }
    if (input.action === "validate") {
      return {
        ...validateLayoutScope(
          await this.getDocument(input.fileKey),
          input.nodeIds,
        ),
        ...this.#metadata(),
      };
    }
    return unsupported(`layout.${input.action}`);
  }

  async component(
    input: ComponentActionInput,
  ): Promise<Record<string, unknown>> {
    if (input.action === "search" || input.action === "inspect") {
      const components = localComponents(await this.getDocument(input.fileKey));
      if (input.action === "search") {
        const query = input.query?.toLowerCase();
        return {
          components: query
            ? components.filter((component) =>
                component.name.toLowerCase().includes(query),
              )
            : components,
          ...this.#metadata(),
        };
      }
      const component = components.find(
        (candidate) =>
          candidate.nodeId === input.componentId ||
          candidate.key === input.componentKey,
      );
      if (!component) {
        throw new McpFigError(
          "NODE_NOT_FOUND",
          "Figma component was not found.",
        );
      }
      return { component, ...this.#metadata() };
    }
    return unsupported(`component.${input.action}`);
  }

  async instance(input: InstanceActionInput): Promise<Record<string, unknown>> {
    return unsupported(`instance.${input.action}`);
  }

  async tokens(input: TokenActionInput): Promise<Record<string, unknown>> {
    return unsupported(`tokens.${input.action}`);
  }

  async styles(input: StyleActionInput): Promise<Record<string, unknown>> {
    return unsupported(`styles.${input.action}`);
  }

  async visual(input: VisualActionInput): Promise<Record<string, unknown>> {
    return unsupported(`visual.${input.action}`);
  }

  async #loadFile(fileKey: string): Promise<RestFileResponse> {
    const response = await this.#request<RestFileResponse>(
      `/v1/files/${encodeURIComponent(fileKey)}`,
    );
    this.#activeFileKey = fileKey;
    this.#fileName = response.name;
    this.#revision = response.version;
    this.#verified = true;
    return response;
  }

  #requireFileKey(fileKey?: string): string {
    const key = fileKey ?? this.#activeFileKey;
    if (!key) {
      throw new McpFigError(
        "FILE_NOT_TARGETED",
        "No Figma file is targeted. Set FIGMA_FILE_KEY or call figma_connection.target.",
      );
    }
    return key;
  }

  #metadata(): {
    source: "rest";
    revision: string;
    freshnessWarning: string;
  } {
    return {
      source: "rest",
      revision: this.#revision ?? "unknown",
      freshnessWarning: REST_FRESHNESS_WARNING,
    };
  }

  #withMetadata(node: FigmaNode): FigmaNode {
    return { ...node, ...this.#metadata() };
  }

  async #requireAccessToken(): Promise<string> {
    let token: string | undefined;
    try {
      token = this.#accessToken ?? (await this.#loadAccessToken?.());
    } catch {
      throw new McpFigError(
        "NOT_CONNECTED",
        "Figma REST fallback credential is unavailable.",
        {
          details: {
            source: "rest",
            reason: "REST_CREDENTIAL_UNAVAILABLE",
            dispatched: false,
          },
        },
      );
    }
    if (!token) {
      throw new McpFigError(
        "NOT_CONNECTED",
        "Figma REST fallback is not configured with an owner-only access token.",
        {
          details: {
            source: "rest",
            reason: "REST_CREDENTIAL_MISSING",
            dispatched: false,
          },
        },
      );
    }
    return token;
  }

  async #request<T>(path: string): Promise<T> {
    const accessToken = await this.#requireAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { "X-Figma-Token": accessToken },
        signal: controller.signal,
      });
    } catch (error) {
      this.#verified = false;
      const timedOut = controller.signal.aborted;
      throw new McpFigError(
        "NOT_CONNECTED",
        timedOut
          ? `Figma REST request timed out after ${this.#timeoutMs}ms.`
          : error instanceof Error
            ? error.message
            : "Figma REST request failed.",
        {
          retryable: true,
          details: {
            source: "rest",
            path,
            ...(timedOut ? { timeoutMs: this.#timeoutMs } : {}),
          },
        },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      this.#verified = false;
      const code =
        response.status === 404
          ? "FILE_NOT_FOUND"
          : response.status === 429
            ? "BUSY"
            : "NOT_CONNECTED";
      throw new McpFigError(
        code,
        `Figma REST request failed with HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          details: {
            source: "rest",
            status: response.status,
            path,
            ...(response.headers.get("retry-after")
              ? { retryAfter: response.headers.get("retry-after") }
              : {}),
          },
        },
      );
    }
    return (await response.json()) as T;
  }
}
