import type { LaunchdStatus } from "./launchd.js";
import type { ServiceStatus } from "./protocol.js";
import type {
  StartupError,
  StartupStateName,
  StartupStateSnapshot,
} from "./startup-state.js";

export type AgentServiceState =
  | "not_installed"
  | "stopped"
  | "running"
  | "unavailable";

export interface AgentActionableError {
  code: string;
  message: string;
  action: string;
}

export interface AgentFileStatus {
  sessionId: string;
  clientId: string;
  fileKey: string;
  fileName: string;
  revision: string;
}

export interface AgentServiceStatus {
  service: AgentServiceState;
  pluginSessionCount: number;
  files: AgentFileStatus[];
  lastHandshakeAt: string | null;
  actionableError: AgentActionableError | null;
  startupRunId: string | null;
  startupState: StartupStateName;
  attemptsUsed: number;
  stageStartedAt: string | null;
  lastProgressAt: string | null;
  leaseExpiresAt: string | null;
  lastStartupError: StartupError | null;
  circuitOpenUntil: string | null;
  lastVerifiedPluginAt: string | null;
}

function actionableError(
  launchd: LaunchdStatus,
  daemonStatus: ServiceStatus | undefined,
  daemonError: unknown,
  startup: StartupStateSnapshot,
): AgentActionableError | null {
  if (!launchd.loaded) {
    return {
      code: "SERVICE_NOT_INSTALLED",
      message: "MCP Fig service is not installed.",
      action: "Run `mcp-fig service install` before starting the Plugin.",
    };
  }
  if (!launchd.running) {
    return {
      code: "SERVICE_STOPPED",
      message: "MCP Fig service is installed but stopped.",
      action: "Run `mcp-fig service start`, then check status again.",
    };
  }
  if (daemonError || !daemonStatus) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "MCP Fig daemon did not answer its owner-only socket.",
      action: "Run `mcp-fig service restart`, then check status again.",
    };
  }
  if (startup.lastStartupError?.actionRequired) {
    return {
      code: startup.lastStartupError.code,
      message: startup.lastStartupError.message,
      action: startup.circuitOpenUntil
        ? `Wait until ${startup.circuitOpenUntil}, or use an approved reset signal.`
        : "Resolve the blocker, then run `mcp-fig service startup begin --explicit-retry --json`.",
    };
  }
  if (daemonStatus.daemon.sessions.length === 0) {
    return {
      code: "PLUGIN_NOT_CONNECTED",
      message: "The daemon is running without an active Figma Plugin session.",
      action: "Open Figma and run Plugins > Development > MCP Fig Live Bridge.",
    };
  }
  return null;
}

export function buildAgentServiceStatus(input: {
  launchd: LaunchdStatus;
  daemonStatus?: ServiceStatus;
  daemonError?: unknown;
  startup: StartupStateSnapshot;
}): AgentServiceStatus {
  const sessions = input.daemonStatus?.daemon.sessions ?? [];
  const service: AgentServiceState = !input.launchd.loaded
    ? "not_installed"
    : !input.launchd.running
      ? "stopped"
      : input.daemonStatus
        ? "running"
        : "unavailable";
  return {
    service,
    pluginSessionCount: sessions.length,
    files: sessions.map((session) => ({
      sessionId: session.sessionId,
      clientId: session.clientId,
      fileKey: session.file.key,
      fileName: session.file.name,
      revision: session.file.revision,
    })),
    lastHandshakeAt:
      input.daemonStatus?.daemon.lastHandshakeAt ??
      input.startup.lastVerifiedPluginAt,
    actionableError: actionableError(
      input.launchd,
      input.daemonStatus,
      input.daemonError,
      input.startup,
    ),
    startupRunId: input.startup.startupRunId,
    startupState: input.startup.startupState,
    attemptsUsed: input.startup.attemptsUsed,
    stageStartedAt: input.startup.stageStartedAt,
    lastProgressAt: input.startup.lastProgressAt,
    leaseExpiresAt: input.startup.leaseExpiresAt,
    lastStartupError: input.startup.lastStartupError,
    circuitOpenUntil: input.startup.circuitOpenUntil,
    lastVerifiedPluginAt: input.startup.lastVerifiedPluginAt,
  };
}
