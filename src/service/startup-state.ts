import { randomUUID } from "node:crypto";

import {
  readOwnerOnlyFile,
  type ServicePaths,
  writeOwnerOnlyFile,
} from "./paths.js";

export const STARTUP_LEASE_MS = 10 * 60_000;
export const STARTUP_CIRCUIT_MS = 10 * 60_000;
export const STARTUP_MAX_ATTEMPTS = 3;

const ACTION_IDENTIFIER = /^[a-z][a-z0-9.-]{0,79}$/;
const ERROR_CODE_IDENTIFIER = /^[A-Z][A-Z0-9_]{0,79}$/;
const RUN_IDENTIFIER = /^[A-Za-z0-9._-]{1,80}$/;

export const STARTUP_STAGE_BUDGETS = {
  "figma-launching": 90_000,
  "plugin-locating": 60_000,
  "plugin-starting": 60_000,
  "handshake-waiting": 30_000,
} as const;

export const STARTUP_STAGES = [
  "service-check",
  "figma-launching",
  "figma-ready",
  "plugin-locating",
  "plugin-starting",
  "handshake-waiting",
] as const;

export type StartupStage = (typeof STARTUP_STAGES)[number];

export type StartupStateName =
  | "idle"
  | StartupStage
  | "verified"
  | "failed"
  | "paused";

export type StartupResetSignal =
  | "explicit-user-retry"
  | "process-state-change"
  | "window-state-change"
  | "session-state-change"
  | "service-restart";

export type StartupEscalationSignal =
  | "suspected_noop"
  | "background_unavailable"
  | "foreground_recommended";

export interface StartupError {
  code: string;
  message: string;
  stage: StartupStage | null;
  actionRequired: boolean;
}

export interface StartupAction {
  stage: StartupStage;
  action: string;
  mode: "background" | "foreground";
  outcome: "pending" | "succeeded" | "failed" | "blocked";
  at: string;
  errorCode: string | null;
  escalationSignal: StartupEscalationSignal | null;
}

export interface StartupStateSnapshot {
  version: 1;
  startupRunId: string | null;
  startupState: StartupStateName;
  attemptsUsed: number;
  stageStartedAt: string | null;
  lastProgressAt: string | null;
  leaseExpiresAt: string | null;
  lastStartupError: StartupError | null;
  circuitOpenUntil: string | null;
  lastVerifiedPluginAt: string | null;
  lastAction: StartupAction | null;
  observedServiceStartedAt: string | null;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function time(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function activeStage(state: StartupStateSnapshot): StartupStage | undefined {
  return STARTUP_STAGES.includes(state.startupState as StartupStage)
    ? (state.startupState as StartupStage)
    : undefined;
}

export function initialStartupState(): StartupStateSnapshot {
  return {
    version: 1,
    startupRunId: null,
    startupState: "idle",
    attemptsUsed: 0,
    stageStartedAt: null,
    lastProgressAt: null,
    leaseExpiresAt: null,
    lastStartupError: null,
    circuitOpenUntil: null,
    lastVerifiedPluginAt: null,
    lastAction: null,
    observedServiceStartedAt: null,
  };
}

function failure(
  state: StartupStateSnapshot,
  now: number,
  error: StartupError,
  attemptsUsed: number,
): StartupStateSnapshot {
  const exhausted = attemptsUsed >= STARTUP_MAX_ATTEMPTS;
  return {
    ...state,
    attemptsUsed,
    startupState: exhausted ? "failed" : state.startupState,
    stageStartedAt: exhausted ? state.stageStartedAt : iso(now),
    lastProgressAt: exhausted ? state.lastProgressAt : iso(now),
    lastStartupError: error,
    circuitOpenUntil: exhausted ? iso(now + STARTUP_CIRCUIT_MS) : null,
  };
}

export function beginStartup(
  state: StartupStateSnapshot,
  now: number,
  options: {
    runId?: string;
    resetSignal?: StartupResetSignal;
    observedServiceStartedAt?: string;
  } = {},
): StartupStateSnapshot {
  const evaluated = evaluateStartup(state, now);
  const circuitUntil = time(evaluated.circuitOpenUntil);
  if (
    circuitUntil !== undefined &&
    now < circuitUntil &&
    !options.resetSignal
  ) {
    return evaluated;
  }
  if (
    evaluated.startupRunId &&
    !["idle", "failed"].includes(evaluated.startupState) &&
    !options.resetSignal
  ) {
    return evaluated;
  }
  const startedAt = iso(now);
  const runId = options.runId ?? randomUUID();
  if (!RUN_IDENTIFIER.test(runId)) {
    throw new Error("Startup run ID must be a safe diagnostic identifier.");
  }
  return {
    version: 1,
    startupRunId: runId,
    startupState: "service-check",
    attemptsUsed: 0,
    stageStartedAt: startedAt,
    lastProgressAt: startedAt,
    leaseExpiresAt: iso(now + STARTUP_LEASE_MS),
    lastStartupError: null,
    circuitOpenUntil: null,
    lastVerifiedPluginAt: evaluated.lastVerifiedPluginAt,
    lastAction: null,
    observedServiceStartedAt:
      options.observedServiceStartedAt ?? evaluated.observedServiceStartedAt,
  };
}

export function setStartupStage(
  state: StartupStateSnapshot,
  stage: StartupStage,
  now: number,
): StartupStateSnapshot {
  if (["verified", "paused", "failed"].includes(state.startupState)) {
    return state;
  }
  if (state.startupState === stage) return state;
  return {
    ...state,
    startupState: stage,
    stageStartedAt: iso(now),
    lastProgressAt: iso(now),
    lastStartupError: null,
    lastAction: null,
  };
}

export function markStartupProgress(
  state: StartupStateSnapshot,
  stage: StartupStage,
  now: number,
): StartupStateSnapshot {
  const next =
    state.startupState === stage ? state : setStartupStage(state, stage, now);
  if (next.startupState !== stage) return next;
  return { ...next, lastProgressAt: iso(now) };
}

export function evaluateStartup(
  state: StartupStateSnapshot,
  now: number,
): StartupStateSnapshot {
  const stage = activeStage(state);
  if (!stage) return state;
  const leaseExpiresAt = time(state.leaseExpiresAt);
  if (leaseExpiresAt !== undefined && now > leaseExpiresAt) {
    return {
      ...state,
      startupState: "failed",
      lastStartupError: {
        code: "STARTUP_LEASE_EXPIRED",
        message: "The ten-minute startup lease expired.",
        stage,
        actionRequired: true,
      },
      circuitOpenUntil: iso(now + STARTUP_CIRCUIT_MS),
    };
  }
  if (
    state.lastAction?.stage !== stage ||
    state.lastAction.outcome !== "pending"
  ) {
    return state;
  }
  const budget =
    STARTUP_STAGE_BUDGETS[stage as keyof typeof STARTUP_STAGE_BUDGETS];
  const progressAt = time(state.lastProgressAt);
  if (budget && progressAt !== undefined && now - progressAt > budget) {
    if (
      state.lastStartupError?.code === "STAGE_INACTIVITY_TIMEOUT" &&
      state.lastStartupError.stage === stage &&
      state.lastProgressAt === state.stageStartedAt
    ) {
      return state;
    }
    const failed = failure(
      state,
      now,
      {
        code: "STAGE_INACTIVITY_TIMEOUT",
        message: `No progress was observed during ${stage}.`,
        stage,
        actionRequired: false,
      },
      state.attemptsUsed + 1,
    );
    return {
      ...failed,
      stageStartedAt: failed.lastProgressAt,
      lastAction: {
        ...state.lastAction,
        outcome: "failed",
        at: iso(now),
        errorCode: "STAGE_INACTIVITY_TIMEOUT",
      },
    };
  }
  return state;
}

function allowedForeground(
  signal: StartupEscalationSignal | undefined,
): boolean {
  return Boolean(signal);
}

export function recordStartupAction(
  state: StartupStateSnapshot,
  now: number,
  action: {
    stage: StartupStage;
    action: string;
    mode: "background" | "foreground";
    outcome: "pending" | "succeeded" | "failed" | "blocked";
    errorCode?: string;
    escalationSignal?: StartupEscalationSignal;
  },
): StartupStateSnapshot {
  if (!ACTION_IDENTIFIER.test(action.action)) {
    throw new Error(
      "Startup action must be a lowercase diagnostic identifier.",
    );
  }
  if (action.errorCode && !ERROR_CODE_IDENTIFIER.test(action.errorCode)) {
    throw new Error(
      "Startup error code must be an uppercase diagnostic identifier.",
    );
  }
  const evaluated = evaluateStartup(state, now);
  if (
    evaluated.startupState === "failed" ||
    evaluated.startupState === "paused" ||
    evaluated.startupState === "verified"
  ) {
    return evaluated;
  }
  if (
    action.mode === "foreground" &&
    !allowedForeground(action.escalationSignal)
  ) {
    return {
      ...evaluated,
      startupState: "paused",
      lastStartupError: {
        code: "FOREGROUND_ESCALATION_NOT_ALLOWED",
        message:
          "Foreground escalation requires an explicit computer-use failure signal.",
        stage: action.stage,
        actionRequired: true,
      },
    };
  }
  if (
    action.outcome === "pending" &&
    evaluated.lastAction?.outcome === "pending" &&
    evaluated.lastAction.stage === action.stage
  ) {
    return evaluated;
  }
  const recorded: StartupAction = {
    stage: action.stage,
    action: action.action.slice(0, 80),
    mode: action.mode,
    outcome: action.outcome,
    at: iso(now),
    errorCode: action.errorCode?.slice(0, 80) ?? null,
    escalationSignal: action.escalationSignal ?? null,
  };
  if (action.outcome === "blocked") {
    return {
      ...evaluated,
      startupState: "paused",
      lastAction: recorded,
      lastStartupError: {
        code: action.errorCode ?? "ACTION_REQUIRED",
        message: "Startup needs explicit user action.",
        stage: action.stage,
        actionRequired: true,
      },
    };
  }
  if (action.outcome === "failed") {
    return {
      ...failure(
        evaluated,
        now,
        {
          code: action.errorCode ?? "STARTUP_ACTION_FAILED",
          message: `${action.action} failed during ${action.stage}.`,
          stage: action.stage,
          actionRequired: false,
        },
        evaluated.attemptsUsed + 1,
      ),
      lastAction: recorded,
    };
  }
  return {
    ...evaluated,
    startupState: action.stage,
    lastProgressAt:
      action.outcome === "succeeded" ? iso(now) : evaluated.lastProgressAt,
    lastAction: recorded,
  };
}

export function markStartupVerified(
  state: StartupStateSnapshot,
  now: number,
  observedServiceStartedAt?: string,
): StartupStateSnapshot {
  return {
    ...state,
    startupState: "verified",
    stageStartedAt: state.stageStartedAt,
    lastProgressAt: iso(now),
    lastStartupError: null,
    circuitOpenUntil: null,
    lastVerifiedPluginAt: iso(now),
    lastAction: null,
    observedServiceStartedAt:
      observedServiceStartedAt ?? state.observedServiceStartedAt,
  };
}

function nullableTimestamp(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && time(value) !== undefined)
  );
}

function nullableIdentifier(
  value: unknown,
  pattern: RegExp,
): value is string | null {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function validError(value: unknown): value is StartupError | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<StartupError>;
  return (
    typeof error.code === "string" &&
    ERROR_CODE_IDENTIFIER.test(error.code) &&
    typeof error.message === "string" &&
    error.message.length <= 200 &&
    (error.stage === null ||
      STARTUP_STAGES.includes(error.stage as StartupStage)) &&
    typeof error.actionRequired === "boolean"
  );
}

function validAction(value: unknown): value is StartupAction | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<StartupAction>;
  return (
    typeof action.stage === "string" &&
    STARTUP_STAGES.includes(action.stage as StartupStage) &&
    typeof action.action === "string" &&
    ACTION_IDENTIFIER.test(action.action) &&
    (action.mode === "background" || action.mode === "foreground") &&
    ["pending", "succeeded", "failed", "blocked"].includes(
      action.outcome ?? "",
    ) &&
    nullableTimestamp(action.at) &&
    nullableIdentifier(action.errorCode, ERROR_CODE_IDENTIFIER) &&
    (action.escalationSignal === null ||
      action.escalationSignal === "suspected_noop" ||
      action.escalationSignal === "background_unavailable" ||
      action.escalationSignal === "foreground_recommended")
  );
}

function validState(value: unknown): value is StartupStateSnapshot {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<StartupStateSnapshot>;
  const states: readonly StartupStateName[] = [
    "idle",
    ...STARTUP_STAGES,
    "verified",
    "failed",
    "paused",
  ];
  return (
    state.version === 1 &&
    typeof state.startupState === "string" &&
    states.includes(state.startupState as StartupStateName) &&
    nullableIdentifier(state.startupRunId, RUN_IDENTIFIER) &&
    Number.isInteger(state.attemptsUsed) &&
    (state.attemptsUsed ?? -1) >= 0 &&
    (state.attemptsUsed ?? STARTUP_MAX_ATTEMPTS + 1) <= STARTUP_MAX_ATTEMPTS &&
    nullableTimestamp(state.stageStartedAt) &&
    nullableTimestamp(state.lastProgressAt) &&
    nullableTimestamp(state.leaseExpiresAt) &&
    validError(state.lastStartupError) &&
    nullableTimestamp(state.circuitOpenUntil) &&
    nullableTimestamp(state.lastVerifiedPluginAt) &&
    validAction(state.lastAction) &&
    nullableTimestamp(state.observedServiceStartedAt)
  );
}

export function observeServiceStarted(
  state: StartupStateSnapshot,
  serviceStartedAt: string,
  now: number,
): StartupStateSnapshot {
  if (
    state.observedServiceStartedAt &&
    state.observedServiceStartedAt !== serviceStartedAt &&
    state.circuitOpenUntil
  ) {
    return beginStartup(state, now, {
      resetSignal: "service-restart",
      observedServiceStartedAt: serviceStartedAt,
    });
  }
  return { ...state, observedServiceStartedAt: serviceStartedAt };
}

export async function readStartupState(
  paths: ServicePaths,
  now = Date.now(),
): Promise<StartupStateSnapshot> {
  try {
    const parsed = JSON.parse(
      await readOwnerOnlyFile(paths.startupStatePath),
    ) as unknown;
    if (!validState(parsed)) throw new Error("Startup state is malformed.");
    return evaluateStartup(parsed, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return initialStartupState();
    throw error;
  }
}

export async function writeStartupState(
  paths: ServicePaths,
  state: StartupStateSnapshot,
): Promise<void> {
  await writeOwnerOnlyFile(
    paths.startupStatePath,
    `${JSON.stringify(state, null, 2)}\n`,
  );
}
