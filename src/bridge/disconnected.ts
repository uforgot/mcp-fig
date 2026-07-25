import { McpFigError } from "../errors.js";
import type {
  BridgeStatus,
  ChangeRecord,
  CloneNodesInput,
  ComponentActionInput,
  CreateNodeInput,
  DeleteNodesInput,
  FigmaBridge,
  FigmaFileSummary,
  FigmaNode,
  InstanceActionInput,
  LayoutActionInput,
  MoveNodesInput,
  ResizeNodesInput,
  TokenActionInput,
  UpdateNodesInput,
} from "./types.js";

function notConnected(): never {
  throw new McpFigError(
    "NOT_CONNECTED",
    "No Figma REST or Desktop Plugin bridge is configured.",
    { retryable: true },
  );
}

export class DisconnectedFigmaBridge implements FigmaBridge {
  async status(): Promise<BridgeStatus> {
    return {
      connected: false,
      mode: "disconnected",
      readSource: "none",
      writeSource: "none",
    };
  }

  async listFiles(): Promise<FigmaFileSummary[]> {
    return [];
  }

  async targetFile(_fileKey: string): Promise<BridgeStatus> {
    return notConnected();
  }

  async reconnect(): Promise<BridgeStatus> {
    return this.status();
  }

  async getDocument(_fileKey?: string): Promise<FigmaNode> {
    return notConnected();
  }

  async getSelection(_fileKey?: string): Promise<string[]> {
    return notConnected();
  }

  async getChanges(_fileKey?: string): Promise<ChangeRecord[]> {
    return notConnected();
  }

  async getNodes(_nodeIds: string[], _fileKey?: string): Promise<FigmaNode[]> {
    return notConnected();
  }

  async createNode(_input: CreateNodeInput): Promise<FigmaNode[]> {
    return notConnected();
  }

  async updateNodes(_input: UpdateNodesInput): Promise<FigmaNode[]> {
    return notConnected();
  }

  async moveNodes(_input: MoveNodesInput): Promise<FigmaNode[]> {
    return notConnected();
  }

  async resizeNodes(_input: ResizeNodesInput): Promise<FigmaNode[]> {
    return notConnected();
  }

  async cloneNodes(_input: CloneNodesInput): Promise<FigmaNode[]> {
    return notConnected();
  }

  async deleteNodes(_input: DeleteNodesInput): Promise<string[]> {
    return notConnected();
  }

  async layout(_input: LayoutActionInput): Promise<Record<string, unknown>> {
    return notConnected();
  }

  async component(
    _input: ComponentActionInput,
  ): Promise<Record<string, unknown>> {
    return notConnected();
  }

  async instance(
    _input: InstanceActionInput,
  ): Promise<Record<string, unknown>> {
    return notConnected();
  }

  async tokens(_input: TokenActionInput): Promise<Record<string, unknown>> {
    return notConnected();
  }
}
