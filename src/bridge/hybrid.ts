import { McpFigError } from "../errors.js";
import { REST_FRESHNESS_WARNING } from "./rest.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  ComponentActionInput,
  CreateNodeInput,
  DeleteNodesInput,
  FigmaBridge,
  FigmaDocumentSummary,
  FigmaFileSummary,
  FigmaNode,
  InstanceActionInput,
  LayoutActionInput,
  MoveNodesInput,
  ResizeNodesInput,
  TokenActionInput,
  UpdateNodesInput,
} from "./types.js";

type RestFallbackBridge = FigmaBridge & {
  isAvailable?: () => Promise<boolean>;
};

const FALLBACK_REASON = "PLUGIN_NOT_CONNECTED_REST_READ_ONLY";

export const HYBRID_REST_CAPABILITY_TABLE = Object.freeze({
  bridgeMethods: Object.freeze([
    "getDocument",
    "getChanges",
    "getNodes",
    "layout",
    "component",
  ]),
  layoutActions: Object.freeze(["inspect", "validate"]),
  componentActions: Object.freeze(["search", "inspect"]),
});

type RestFallbackMethod =
  (typeof HYBRID_REST_CAPABILITY_TABLE.bridgeMethods)[number];

function canFallback(error: unknown): error is McpFigError {
  return (
    error instanceof McpFigError &&
    error.code === "NOT_CONNECTED" &&
    error.details?.dispatched === false
  );
}

export class HybridFigmaBridge implements FigmaBridge {
  readonly #plugin: FigmaBridge;
  readonly #rest: RestFallbackBridge | undefined;

  constructor(plugin: FigmaBridge, rest?: RestFallbackBridge) {
    this.#plugin = plugin;
    this.#rest = rest;
  }

  async close(): Promise<void> {
    await Promise.all([this.#plugin.close?.(), this.#rest?.close?.()]);
  }

  async status(): Promise<BridgeStatus> {
    let pluginStatus: BridgeStatus | undefined;
    try {
      pluginStatus = await this.#plugin.status();
    } catch {
      pluginStatus = undefined;
    }
    const pluginConnected = pluginStatus?.connected === true;
    const restAvailable = await this.#restAvailable();
    let restStatus: BridgeStatus | undefined;
    if (restAvailable) {
      try {
        restStatus = await this.#rest?.status();
      } catch {
        restStatus = undefined;
      }
    }
    const readSource = pluginConnected
      ? "desktop-plugin"
      : restAvailable
        ? "rest"
        : "none";
    const sourceStatus = readSource === "rest" ? restStatus : pluginStatus;
    return {
      connected: pluginConnected || restAvailable,
      mode: "hybrid",
      ...(sourceStatus?.fileKey ? { fileKey: sourceStatus.fileKey } : {}),
      ...(sourceStatus?.fileName ? { fileName: sourceStatus.fileName } : {}),
      ...(sourceStatus?.revision ? { revision: sourceStatus.revision } : {}),
      readSource,
      writeSource: pluginConnected ? "desktop-plugin" : "none",
      pluginConnected,
      restAvailable,
      ...(!pluginConnected && restAvailable
        ? {
            connectionState: "degraded" as const,
            degradedReason: FALLBACK_REASON,
            freshnessWarning: REST_FRESHNESS_WARNING,
          }
        : !pluginConnected
          ? { degradedReason: "PLUGIN_AND_REST_UNAVAILABLE" }
          : {}),
    };
  }

  listFiles(): Promise<FigmaFileSummary[]> {
    return this.#plugin.listFiles();
  }

  targetFile(fileKey: string): Promise<BridgeStatus> {
    return this.#plugin.targetFile(fileKey);
  }

  reconnect(): Promise<BridgeStatus> {
    return this.#plugin.reconnect();
  }

  async getDocument(fileKey?: string): Promise<FigmaNode> {
    return this.#read(
      "getDocument",
      () => this.#plugin.getDocument(fileKey),
      () => this.#rest?.getDocument(fileKey),
    );
  }

  getDocumentSummary(fileKey?: string): Promise<FigmaDocumentSummary> {
    if (!this.#plugin.getDocumentSummary) {
      return Promise.reject(
        new McpFigError(
          "UNSUPPORTED_BY_BRIDGE",
          "document.summary is unavailable on the Plugin bridge.",
        ),
      );
    }
    return this.#plugin.getDocumentSummary(fileKey);
  }

  getSelection(fileKey?: string): Promise<string[]> {
    return this.#plugin.getSelection(fileKey);
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    return this.#read(
      "getChanges",
      () => this.#plugin.getChanges(fileKey),
      () => this.#rest?.getChanges(fileKey),
    );
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    return this.#read(
      "getNodes",
      () => this.#plugin.getNodes(nodeIds, fileKey),
      () => this.#rest?.getNodes(nodeIds, fileKey),
    );
  }

  createNode(input: CreateNodeInput): Promise<FigmaNode[]> {
    return this.#plugin.createNode(input);
  }

  updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]> {
    return this.#plugin.updateNodes(input);
  }

  moveNodes(input: MoveNodesInput): Promise<FigmaNode[]> {
    return this.#plugin.moveNodes(input);
  }

  resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]> {
    return this.#plugin.resizeNodes(input);
  }

  cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]> {
    return this.#plugin.cloneNodes(input);
  }

  deleteNodes(input: DeleteNodesInput): Promise<string[]> {
    return this.#plugin.deleteNodes(input);
  }

  async layout(input: LayoutActionInput): Promise<Record<string, unknown>> {
    if (!HYBRID_REST_CAPABILITY_TABLE.layoutActions.includes(input.action)) {
      return this.#plugin.layout(input);
    }
    return this.#read(
      "layout",
      () => this.#plugin.layout(input),
      () => this.#rest?.layout(input),
    );
  }

  async component(
    input: ComponentActionInput,
  ): Promise<Record<string, unknown>> {
    if (!HYBRID_REST_CAPABILITY_TABLE.componentActions.includes(input.action)) {
      return this.#plugin.component(input);
    }
    return this.#read(
      "component",
      () => this.#plugin.component(input),
      () => this.#rest?.component(input),
    );
  }

  instance(input: InstanceActionInput): Promise<Record<string, unknown>> {
    return this.#plugin.instance(input);
  }

  tokens(input: TokenActionInput): Promise<Record<string, unknown>> {
    return this.#plugin.tokens(input);
  }

  async #read<Result>(
    method: RestFallbackMethod,
    pluginRead: () => Promise<Result>,
    restRead: () => Promise<Result> | undefined,
  ): Promise<Result> {
    try {
      const result = await pluginRead();
      return result;
    } catch (error) {
      if (!canFallback(error)) throw error;
      if (!HYBRID_REST_CAPABILITY_TABLE.bridgeMethods.includes(method)) {
        throw error;
      }
      const pending = restRead();
      if (!pending) throw error;
      try {
        return await pending;
      } catch (restError) {
        if (
          restError instanceof McpFigError &&
          restError.code === "FILE_NOT_TARGETED"
        ) {
          throw new McpFigError(
            "NOT_CONNECTED",
            "Figma REST fallback requires a cloud file key.",
            {
              details: {
                source: "rest",
                reason: "REST_FILE_KEY_MISSING",
                dispatched: false,
              },
            },
          );
        }
        throw restError;
      }
    }
  }

  async #restAvailable(): Promise<boolean> {
    if (!this.#rest) return false;
    if (this.#rest.isAvailable) return this.#rest.isAvailable();
    try {
      const status = await this.#rest.status();
      return status.restAvailable ?? status.readSource === "rest";
    } catch {
      return false;
    }
  }
}
