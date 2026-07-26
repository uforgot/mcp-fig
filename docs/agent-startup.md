# Agent-assisted Figma Plugin startup

GUI startup is a best-effort adapter around the persistent service. The service, its startup state, and `service status --json` are authoritative. GUI success is not inferred from a visible Plugin label.

## Safety boundary

- Work background-first. Foreground is a reaction to a returned failure signal, not a prediction about Figma.
- Never click macOS permission, password, keychain, login, payment, or security dialogs. Stop and ask the user.
- Never type, copy, reveal, log, or screenshot a service credential or manual token.
- Enter a one-time pairing code only after explicit user approval for that attempt.
- GUI failure must not stop a healthy daemon, rotate/delete credentials, or start a second Figma process.
- Polling, AI delay, and session resume do not consume attempts. Only a persisted failed startup action does.

## Read service state first

```bash
node dist/index.js service status --json
```

Stable top-level fields:

| Field | Meaning |
| --- | --- |
| `service` | `not_installed`, `stopped`, `running`, or `unavailable` |
| `pluginSessionCount` | Ready Plugin session count |
| `files` | Safe session/client/file metadata |
| `lastHandshakeAt` | Last accepted Plugin handshake or `null` |
| `actionableError` | Stable safe error and one next action |
| `startupRunId`, `startupState`, `attemptsUsed` | Persisted startup run and attempt state |
| `stageStartedAt`, `lastProgressAt`, `leaseExpiresAt` | Timing evidence |
| `lastStartupError`, `circuitOpenUntil` | Redacted failure/circuit state |
| `lastVerifiedPluginAt` | Last status-confirmed Plugin session |

Success requires all of:

```text
service == "running"
pluginSessionCount >= 1
files.length >= 1
lastHandshakeAt != null
```

If already true, run `service startup verify --json` and stop. Do not reopen Figma or rerun the Plugin.

## Persistent startup state

Use the CLI; do not edit `startup-state.json` directly.

```bash
node dist/index.js service startup begin --json
node dist/index.js service startup stage <stage> --json
node dist/index.js service startup progress <stage> --json
node dist/index.js service startup action <stage> <action> <background|foreground> \
  <pending|succeeded|failed|blocked> [error-code] [escalation-signal] --json
node dist/index.js service startup verify --json
node dist/index.js service startup status --json
```

Stages are `service-check`, `figma-launching`, `figma-ready`, `plugin-locating`, `plugin-starting`, `handshake-waiting`, then `verified`, `paused`, or `failed`.

The implementation currently uses inactivity budgets of 90 seconds for Figma launch, 60 seconds for Plugin location, 60 seconds for Plugin start, and 30 seconds for handshake. The run lease and circuit cooldown are each 10 minutes; maximum actual failed actions is 3. Progress signals reset the current stage timer. A timeout consumes one attempt only for a persisted pending action.

Allowed circuit resets are explicit user retry, observed process/window/session change, confirmed service restart, or cooldown expiry.

## computer_use ladder

1. Capture Figma with `mode="som"` and `app="Figma"`; use the accessibility labels and element indexes.
2. Act with background delivery first.
3. Interpret the returned result:
   - `effect=confirmed` and `verified=true`: continue.
   - `effect=unverifiable`: recapture and verify state before another action.
   - `effect=suspected_noop`, `code=background_unavailable`, or an escalation recommendation: do not repeat the same rung.
4. If `escalation.recommended=px`, repeat the same action using a screenshot-derived coordinate.
5. If `escalation.recommended=foreground`, or the pixel rung still fails, request/record that signal and repeat the same action once with foreground delivery. Foreground requires approval and should not interrupt active user work.
6. After every state-changing action, recapture or use `capture_after=true`.

Never use stale coordinates or blindly click **Run last plugin**. If background actions consistently fail, ask the user to run `hermes computer-use doctor` and share the result.

## Procedure

### 1. Doctor and service

```bash
hermes computer-use doctor
node dist/index.js service status --json
```

- Missing Accessibility/Screen Recording: record a blocked action and ask the user to grant permission manually.
- `not_installed`: run `service install`.
- `stopped`: run `service start`.
- `unavailable`: inspect service logs; do not repair through Figma.
- Continue only when the service is running.

Begin/resume the persisted run:

```bash
node dist/index.js service startup begin --json
node dist/index.js service startup stage service-check --json
node dist/index.js service startup progress service-check --json
```

### 2. Observe Figma before opening it

List/capture Figma windows in the background. If a process/window exists, route input to it without raising it. If none exists, record one pending background `open-figma` action, open/focus once, and wait for process/window evidence. Do not call open repeatedly while the same pending action has no new signal.

### 3. Locate the exact Plugin

Capture the current accessible menu labels. The expected path is:

```text
Plugins > Development > MCP Fig Live Bridge
```

Use **Run last plugin** only if capture proves the last Plugin is MCP Fig Live Bridge. If the Plugin window already exists, skip the click and verify the handshake.

### 4. Pair only when approved

The safe field is **One-time pairing code**. If pairing is required, pause for explicit approval, run `service pair`, and enter that short-lived code once. Never expand or automate **Manual development token**. If only a token/session-token/credential field is visible, stop with `PAIRING_UI_UNSAFE`.

### 5. Verify the broker

```bash
node dist/index.js service startup stage handshake-waiting --json
node dist/index.js service status --json
node dist/index.js service startup verify --json
node dist/index.js service status --json
```

The final status must show a running service, non-zero session/files, a handshake, and `startupState=verified`.

## Failure evidence

| Condition | Preserve | Safe response |
| --- | --- | --- |
| Computer-use session ended | Driver/session code and state, no screenshot secrets | Revive only if the adapter explicitly supports it; otherwise pause. |
| Missing permissions | Doctor check names/results | Ask the user; do not click the dialog. |
| Process but no window | Process/window observations | Check other Space/minimized windows; no duplicate launch. |
| Background no-op | Exact returned effect/code/recommendation | Climb only the recommended ladder rung. |
| Menu changed | Current AX/menu labels | Use current labels or ask the user to run the Plugin manually. |
| Plugin absent | Development menu without MCP Fig entry | Ask the user to import `plugin/manifest.json`. |
| Manual-token-only UI | Field labels, contents omitted | Stop with `PAIRING_UI_UNSAFE`. |
| Handshake timeout | Status and stage timestamps | Record one failed pending action; do not rotate credentials. |
| Circuit open | Attempts/error/circuit deadline | Wait or use an allowed reset signal. |

Record labels, codes, timestamps, and state transitions only. Do not retain screenshots containing pairing codes, private file content, or credential fields.

## Gate

```bash
npx vitest run tests/startup-state.test.ts tests/agent-status.test.ts tests/agent-startup-cli.test.ts tests/service-lifecycle.test.ts
hermes computer-use doctor
```

When Figma is safely available, verify one real background capture/menu path and the final service status. If GUI startup is blocked, report it as blocked; do not replace it with fixture or fake-transport success.
