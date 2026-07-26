import { McpFigError } from "../../errors.js";
import type { PluginHandshake } from "../plugin-protocol.js";
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
} from "../types.js";
import { isReadOnlyRequest } from "./write-coordinator.js";

interface BridgeOptions {
  clientId: string;
  requestTimeoutMs?: number;
  fileKey?: string;
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
  #targetFileKey: string | undefined;

  constructor(host: DesktopPluginBridgeTransport, options: BridgeOptions) {
    this.#host = host;
    this.#clientId = options.clientId;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
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
        !resolvedFileKey ||
        !(error instanceof McpFigError) ||
        error.code !== "NOT_CONNECTED"
      )
        throw error;
      await this.#host.waitForSession(resolvedFileKey, 3_000);
      return request();
    }
  }
}
