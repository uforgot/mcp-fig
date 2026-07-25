import { McpFigError } from "../errors.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  CreateNodeInput,
  DeleteNodesInput,
  FigmaBridge,
  FigmaFileSummary,
  FigmaNode,
  MoveNodesInput,
  ResizeNodesInput,
  UpdateNodesInput,
} from "./types.js";

interface RestBridgeOptions {
  accessToken: string;
  fileKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
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
    ...(children ? { children } : {}),
  };
}

export class RestFigmaBridge implements FigmaBridge {
  readonly #accessToken: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  #activeFileKey: string | undefined;
  #fileName: string | undefined;
  #revision: string | undefined;
  #verified = false;

  constructor(options: RestBridgeOptions) {
    this.#accessToken = options.accessToken;
    this.#baseUrl = (options.baseUrl ?? "https://api.figma.com").replace(
      /\/$/,
      "",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
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
    };
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
    return toNode(response.document);
  }

  async getSelection(_fileKey?: string): Promise<string[]> {
    return unsupported("selection.get");
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    const key = this.#requireFileKey(fileKey);
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
      }));
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    const key = this.#requireFileKey(fileKey);
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
      return toNode(document);
    });
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

  async #request<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { "X-Figma-Token": this.#accessToken },
      });
    } catch (error) {
      this.#verified = false;
      throw new McpFigError(
        "NOT_CONNECTED",
        error instanceof Error ? error.message : "Figma REST request failed.",
        { retryable: true },
      );
    }
    if (!response.ok) {
      this.#verified = false;
      const code = response.status === 404 ? "FILE_NOT_FOUND" : "NOT_CONNECTED";
      throw new McpFigError(
        code,
        `Figma REST request failed with HTTP ${response.status}.`,
        {
          retryable: response.status >= 500,
          details: { status: response.status, path },
        },
      );
    }
    return (await response.json()) as T;
  }
}
