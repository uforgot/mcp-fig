import { describe, expect, it } from "vitest";

import {
  beginStartup,
  evaluateStartup,
  initialStartupState,
  markStartupProgress,
  markStartupVerified,
  recordStartupAction,
  STARTUP_STAGE_BUDGETS,
  setStartupStage,
} from "../src/service/startup-state.js";

const second = 1_000;
const at = (seconds: number) => seconds * second;

describe("agent startup state machine", () => {
  it("resets stage inactivity on real progress and never counts an idle AI resume", () => {
    let state = beginStartup(initialStartupState(), at(0), {
      runId: "run-slow-figma",
    });
    state = setStartupStage(state, "figma-launching", at(1));

    expect(STARTUP_STAGE_BUDGETS).toEqual({
      "figma-launching": 90_000,
      "plugin-locating": 60_000,
      "plugin-starting": 60_000,
      "handshake-waiting": 30_000,
    });
    expect(evaluateStartup(state, at(100))).toMatchObject({
      startupState: "figma-launching",
      attemptsUsed: 0,
      lastStartupError: null,
    });

    state = markStartupProgress(state, "figma-launching", at(100));
    state = recordStartupAction(state, at(101), {
      stage: "figma-launching",
      action: "open-figma",
      mode: "background",
      outcome: "pending",
    });
    expect(evaluateStartup(state, at(180)).attemptsUsed).toBe(0);

    state = markStartupProgress(state, "figma-launching", at(180));
    expect(evaluateStartup(state, at(270))).toMatchObject({
      startupState: "figma-launching",
      attemptsUsed: 0,
      lastProgressAt: new Date(at(180)).toISOString(),
    });

    const timedOut = evaluateStartup(state, at(271));
    expect(timedOut).toMatchObject({
      startupState: "figma-launching",
      attemptsUsed: 1,
      lastStartupError: {
        code: "STAGE_INACTIVITY_TIMEOUT",
        stage: "figma-launching",
      },
    });
    expect(evaluateStartup(timedOut, at(272)).attemptsUsed).toBe(1);
  });

  it("expires the ten-minute lease without silently starting a new run", () => {
    const state = setStartupStage(
      beginStartup(initialStartupState(), at(0), { runId: "run-lease" }),
      "plugin-locating",
      at(1),
    );
    const expired = evaluateStartup(state, at(601));
    expect(expired).toMatchObject({
      startupRunId: "run-lease",
      startupState: "failed",
      lastStartupError: { code: "STARTUP_LEASE_EXPIRED" },
      circuitOpenUntil: new Date(at(1_201)).toISOString(),
    });
  });

  it("counts only actual failed actions and opens the circuit after three", () => {
    let state = setStartupStage(
      beginStartup(initialStartupState(), at(0), { runId: "run-attempts" }),
      "plugin-starting",
      at(1),
    );
    state = recordStartupAction(state, at(2), {
      stage: "plugin-starting",
      action: "menu-click",
      mode: "background",
      outcome: "failed",
      errorCode: "SUSPECTED_NOOP",
    });
    expect(state.attemptsUsed).toBe(1);
    state = recordStartupAction(state, at(3), {
      stage: "plugin-starting",
      action: "menu-click",
      mode: "background",
      outcome: "failed",
      errorCode: "SUSPECTED_NOOP",
    });
    state = recordStartupAction(state, at(4), {
      stage: "plugin-starting",
      action: "menu-click",
      mode: "foreground",
      outcome: "failed",
      errorCode: "BACKGROUND_UNAVAILABLE",
      escalationSignal: "background_unavailable",
    });
    expect(state).toMatchObject({
      attemptsUsed: 3,
      startupState: "failed",
      circuitOpenUntil: new Date(at(604)).toISOString(),
    });
  });

  it("blocks duplicate pending actions and blind foreground escalation", () => {
    let state = setStartupStage(
      beginStartup(initialStartupState(), at(0), { runId: "run-actions" }),
      "figma-launching",
      at(1),
    );
    state = recordStartupAction(state, at(2), {
      stage: "figma-launching",
      action: "open-figma",
      mode: "background",
      outcome: "pending",
    });
    expect(
      recordStartupAction(state, at(3), {
        stage: "figma-launching",
        action: "launch-figma-again",
        mode: "background",
        outcome: "pending",
      }),
    ).toMatchObject({ attemptsUsed: 0, lastAction: state.lastAction });

    const paused = recordStartupAction(state, at(4), {
      stage: "figma-launching",
      action: "open-figma",
      mode: "foreground",
      outcome: "pending",
    });
    expect(paused).toMatchObject({
      startupState: "paused",
      attemptsUsed: 0,
      lastStartupError: { code: "FOREGROUND_ESCALATION_NOT_ALLOWED" },
    });
  });

  it("pauses permission/password and credential actions without spending an attempt", () => {
    let state = beginStartup(initialStartupState(), at(0), {
      runId: "run-permission",
    });
    state = recordStartupAction(state, at(1), {
      stage: "plugin-locating",
      action: "permission-dialog",
      mode: "background",
      outcome: "blocked",
      errorCode: "ACCESSIBILITY_PERMISSION_REQUIRED",
    });
    expect(state).toMatchObject({
      startupState: "paused",
      attemptsUsed: 0,
      lastStartupError: {
        code: "ACCESSIBILITY_PERMISSION_REQUIRED",
        actionRequired: true,
      },
    });
    expect(setStartupStage(state, "plugin-starting", at(2))).toEqual(state);
    expect(
      recordStartupAction(state, at(2), {
        stage: "plugin-starting",
        action: "menu-click",
        mode: "background",
        outcome: "succeeded",
      }),
    ).toEqual(state);
    expect(beginStartup(state, at(2), { runId: "bypass" })).toEqual(state);
  });

  it("does not permit credential-like values in persisted action metadata", () => {
    const state = setStartupStage(
      beginStartup(initialStartupState(), at(0), { runId: "safe-run" }),
      "plugin-starting",
      at(1),
    );
    expect(() =>
      recordStartupAction(state, at(2), {
        stage: "plugin-starting",
        action: "Bearer secret-value",
        mode: "background",
        outcome: "failed",
      }),
    ).toThrow("lowercase diagnostic identifier");
    expect(() =>
      recordStartupAction(state, at(2), {
        stage: "plugin-starting",
        action: "menu-click",
        mode: "background",
        outcome: "failed",
        errorCode: "credential-like-value",
      }),
    ).toThrow("uppercase diagnostic identifier");
  });

  it("keeps existing sessions idempotent and resets circuit only on approved signals", () => {
    let state = beginStartup(initialStartupState(), at(0), {
      runId: "run-existing",
    });
    state = markStartupVerified(state, at(5));
    expect(markStartupVerified(state, at(6))).toMatchObject({
      startupRunId: "run-existing",
      startupState: "verified",
      attemptsUsed: 0,
      lastVerifiedPluginAt: new Date(at(6)).toISOString(),
    });
    expect(
      beginStartup(state, at(7), { runId: "must-not-restart" }).startupRunId,
    ).toBe("run-existing");

    let failed = setStartupStage(
      beginStartup(initialStartupState(), at(10), { runId: "run-failed" }),
      "handshake-waiting",
      at(11),
    );
    for (let index = 0; index < 3; index += 1) {
      failed = recordStartupAction(failed, at(12 + index), {
        stage: "handshake-waiting",
        action: "wait-handshake",
        mode: "background",
        outcome: "failed",
        errorCode: "HANDSHAKE_TIMEOUT",
      });
    }
    expect(
      beginStartup(failed, at(20), { runId: "blocked" }).startupRunId,
    ).toBe("run-failed");
    expect(
      beginStartup(failed, at(20), {
        runId: "run-user-retry",
        resetSignal: "explicit-user-retry",
      }),
    ).toMatchObject({
      startupRunId: "run-user-retry",
      startupState: "service-check",
      attemptsUsed: 0,
      circuitOpenUntil: null,
    });
  });
});
