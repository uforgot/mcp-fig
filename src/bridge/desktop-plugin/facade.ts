import { McpFigError } from "../../errors.js";
import type { PluginHandshake } from "../plugin-protocol.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  ComponentActionInput,
  CreateNodeInput,
  DeleteNodesInput,
  ExportNodesInput,
  FigmaBridge,
  FigmaDocumentSummary,
  FigmaFileSummary,
  FigmaNode,
  ImageActionInput,
  InstanceActionInput,
  LayoutActionInput,
  MoveNodesInput,
  NodeExportPayload,
  NodeQueryResult,
  QueryNodesInput,
  ResizeNodesInput,
  StyleActionInput,
  TextRangeActionInput,
  TokenActionInput,
  UpdateNodesInput,
  VisualActionInput,
} from "../types.js";
import { isReadOnlyRequest } from "./write-coordinator.js";

interface BridgeOptions {
  clientId: string;
  requestTimeoutMs?: number;
  fileKey?: string;
  waitForSessionOnRead?: boolean;
}

export interface DesktopPluginBridgeTransport {
  close(): Promise<void>;
  statusAsync(fileKey?: string): Promise<BridgeStatus>;
  sessionsAsync(): Promise<PluginHandshake[]>;
  waitForSession(fileKey: string, timeoutMs?: number): Promise<PluginHandshake>;
  request(
    clientId: string,
    method: string,
    params: unknown,
    options?: { fileKey?: string; timeoutMs?: number },
  ): Promise<unknown>;
}

export class DesktopPluginFigmaBridge implements FigmaBridge {
  readonly #host: DesktopPluginBridgeTransport;
  readonly #clientId: string;
  readonly #requestTimeoutMs: number;
  readonly #waitForSessionOnRead: boolean;
  #targetFileKey: string | undefined;

  constructor(host: DesktopPluginBridgeTransport, options: BridgeOptions) {
    this.#host = host;
    this.#clientId = options.clientId;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#waitForSessionOnRead = options.waitForSessionOnRead ?? true;
    this.#targetFileKey = options.fileKey;
  }

  async close(): Promise<void> {
    await this.#host.close();
  }

  async status(): Promise<BridgeStatus> {
    const status = await this.#host.statusAsync(this.#targetFileKey);
    if (!status.connected || !status.fileKey) return status;
    try {
      await this.#host.request(
        this.#clientId,
        "selection.get",
        {},
        { fileKey: status.fileKey },
      );
    } catch {
      return status;
    }
    return this.#host.statusAsync(this.#targetFileKey);
  }

  async listFiles(): Promise<FigmaFileSummary[]> {
    return (await this.#host.sessionsAsync()).map((session) => ({
      key: session.file.key,
      name: session.file.name,
      revision: session.file.revision,
    }));
  }

  async targetFile(fileKey: string): Promise<BridgeStatus> {
    const status = await this.#host.statusAsync(fileKey);
    if (!status.connected) {
      throw new McpFigError(
        "FILE_NOT_FOUND",
        `No paired Desktop Plugin session for file ${fileKey}.`,
        {
          retryable: true,
        },
      );
    }
    this.#targetFileKey = fileKey;
    return status;
  }

  async reconnect(): Promise<BridgeStatus> {
    return this.status();
  }

  async getDocument(fileKey?: string): Promise<FigmaNode> {
    return this.#rpc("document.get", {}, fileKey) as Promise<FigmaNode>;
  }

  async getDocumentSummary(fileKey?: string): Promise<FigmaDocumentSummary> {
    return this.#rpc(
      "document.summary",
      {},
      fileKey,
    ) as Promise<FigmaDocumentSummary>;
  }

  async getSelection(fileKey?: string): Promise<string[]> {
    return this.#rpc("selection.get", {}, fileKey) as Promise<string[]>;
  }

  async getChanges(fileKey?: string): Promise<ChangeRecord[]> {
    return this.#rpc("changes.get", {}, fileKey) as Promise<ChangeRecord[]>;
  }

  async getNodes(nodeIds: string[], fileKey?: string): Promise<FigmaNode[]> {
    return this.#rpc("node.get", { nodeIds }, fileKey) as Promise<FigmaNode[]>;
  }

  async queryNodes(input: QueryNodesInput): Promise<NodeQueryResult> {
    return this.#rpc(
      "node.query",
      input,
      input.fileKey,
    ) as Promise<NodeQueryResult>;
  }

  async textRange(
    input: TextRangeActionInput,
  ): Promise<Record<string, unknown>> {
    return this.#rpc("node.text_range", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async image(input: ImageActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("node.image", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async createNode(input: CreateNodeInput): Promise<FigmaNode[]> {
    return this.#rpc("node.create", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async updateNodes(input: UpdateNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.update", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async moveNodes(input: MoveNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.move", input, input.fileKey) as Promise<FigmaNode[]>;
  }

  async resizeNodes(input: ResizeNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.resize", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async cloneNodes(input: CloneNodesInput): Promise<FigmaNode[]> {
    return this.#rpc("node.clone", input, input.fileKey) as Promise<
      FigmaNode[]
    >;
  }

  async deleteNodes(input: DeleteNodesInput): Promise<string[]> {
    return this.#rpc("node.delete", input, input.fileKey) as Promise<string[]>;
  }

  async exportNodes(input: ExportNodesInput): Promise<NodeExportPayload[]> {
    const exports: NodeExportPayload[] = [];
    for (const nodeId of input.nodeIds) {
      const result = (await this.#rpc(
        "node.export",
        {
          nodeIds: [nodeId],
          format: input.format,
          ...(input.scale !== undefined ? { scale: input.scale } : {}),
        },
        input.fileKey,
      )) as NodeExportPayload[];
      exports.push(...result);
    }
    return exports;
  }

  async layout(input: LayoutActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("layout", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async component(
    input: ComponentActionInput,
  ): Promise<Record<string, unknown>> {
    return this.#rpc("component", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async instance(input: InstanceActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("instance", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async tokens(input: TokenActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("tokens", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async styles(input: StyleActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("styles", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async visual(input: VisualActionInput): Promise<Record<string, unknown>> {
    return this.#rpc("visual", input, input.fileKey) as Promise<
      Record<string, unknown>
    >;
  }

  async #rpc(
    method: string,
    params: unknown,
    fileKey?: string,
  ): Promise<unknown> {
    const resolvedFileKey = fileKey ?? this.#targetFileKey;
    const request = () =>
      this.#host.request(this.#clientId, method, params, {
        ...(resolvedFileKey ? { fileKey: resolvedFileKey } : {}),
        timeoutMs: this.#requestTimeoutMs,
      });
    try {
      return await request();
    } catch (error) {
      if (
        !isReadOnlyRequest(method, params) ||
        !this.#waitForSessionOnRead ||
        !resolvedFileKey ||
        !(error instanceof McpFigError) ||
        error.code !== "NOT_CONNECTED" ||
        error.details?.dispatched !== false
      )
        throw error;
      await this.#host.waitForSession(resolvedFileKey, 3_000);
      return request();
    }
  }
}
