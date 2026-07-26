# Agent-assisted Figma Plugin startup

This runbook lets an agent start **MCP Fig Live Bridge** without taking ownership of the persistent broker, its launchd lifecycle, or long-lived credentials. GUI automation is a best-effort adapter. The service and its state file remain authoritative.

## Safety contract

- Work background-first. Do not foreground Figma unless a background action returns `suspected_noop`, `background_unavailable`, or an explicit foreground recommendation.
- Do not click macOS permission, password, keychain, login, or security dialogs. Pause and ask the user.
- Do not type, copy, reveal, log, or screenshot a service token, long-lived credential, or manual development token.
- A one-time pairing code may be entered only after the user approves that pairing attempt. Never reuse a code.
- Do not rotate or delete credentials because GUI automation failed.
- Do not stop or restart a healthy broker to repair a Figma window problem.
- Never launch a second Figma process when a process or window already exists.
- Polling and resuming an AI turn do not consume attempts. Only a failed startup action does.

## Agent-readable status

Always inspect the service before touching Figma:

```sh
mcp-fig service status --json
```

Stable top-level fields:

| Field | Meaning |
| --- | --- |
| `service` | `not_installed`, `stopped`, `running`, or `unavailable` |
| `pluginSessionCount` | Number of ready Plugin sessions |
| `files` | Connected file metadata only: `fileKey`, `fileName`, `revision`, `sessionId`, `clientId` |
| `lastHandshakeAt` | Last accepted Plugin handshake time or `null` |
| `actionableError` | Stable `code`, safe `message`, and one next `action`, or `null` |
| `startupRunId` | Persistent startup attempt identity or `null` |
| `startupState` | Persistent stage or terminal state |
| `attemptsUsed` | Failed actions in the current run, maximum 3 |
| `stageStartedAt`, `lastProgressAt`, `leaseExpiresAt` | Timing evidence |
| `lastStartupError` | Redacted error code, stage, message, and recovery |
| `circuitOpenUntil` | Retry suppression deadline or `null` |
| `lastVerifiedPluginAt` | Last status-confirmed Plugin session or `null` |

`launchd` and `daemon` remain in the output for compatibility. The status command never emits credentials or raw socket errors.

Success is only:

```text
service == "running"
pluginSessionCount >= 1
files.length >= 1
lastHandshakeAt != null
```

If those conditions already hold, record `service startup verify` and stop. Re-running Figma or the Plugin is unnecessary.

## Persistent startup state

The adapter updates an owner-only `startup-state.json` file through the service CLI. Do not edit the file directly.

```sh
mcp-fig service startup begin --json
mcp-fig service startup stage <stage> --json
mcp-fig service startup progress <stage> --json
mcp-fig service startup action <stage> <action> <background|foreground> \
  <pending|succeeded|failed|blocked> [error-code] [escalation-signal] --json
mcp-fig service startup verify --json
mcp-fig service startup status --json
```

Stages:

1. `service-check`
2. `figma-launching`
3. `figma-ready`
4. `plugin-locating`
5. `plugin-starting`
6. `handshake-waiting`
7. `verified`, `paused`, or `failed`

Inactivity budgets:

- Figma launch: 90 seconds
- Plugin location/start: 60 seconds each
- Handshake: 30 seconds
- Whole-run lease: 10 minutes

Visible process/window/menu/session changes are progress and reset only the current stage inactivity timer. Status polling does not. A stage timeout records one failed action only when that stage has a persisted `pending` action; an idle stage or AI turn delay does not consume an attempt. The timed-out action becomes `failed`, so repeated polls cannot count it again.

After 3 failed actions or lease expiry, the circuit opens for 10 minutes and the state becomes `failed`. A new run is allowed only after one of these confirmed signals:

- explicit user retry: `service startup begin --explicit-retry --json`
- Figma process/window state change: `--figma-state-change`
- successful service restart: `--service-restart`
- circuit cooldown expiry

A daemon `startedAt` change is also detected by `service status --json`; it resets a circuit-open run without changing credentials.

## Background-first procedure

### 1. Doctor and service

```sh
hermes computer-use doctor
mcp-fig service status --json
```

- If doctor reports missing Accessibility or Screen Recording, do not open the permission dialog. Record a blocked action and ask the user to grant access manually.
- If `service=not_installed`, the safe action is `mcp-fig service install`.
- If `service=stopped`, use `mcp-fig service start`.
- If `service=unavailable`, preserve the emitted actionable error and inspect service logs. Do not repair it through Figma.
- Re-read status. Do not continue until `service=running`.

Begin or resume the run:

```sh
mcp-fig service startup begin --json
mcp-fig service startup stage service-check --json
mcp-fig service startup progress service-check --json
```

### 2. Observe Figma before opening it

Use background `computer_use` discovery/capture first:

1. Inspect running apps/windows.
2. Capture with `app="Figma"`, `mode="som"` or `mode="ax"`.
3. If a Figma process or window exists, focus it in background. Do not launch another copy.
4. If no process exists, record a background pending action, open/focus Figma once, then wait for process/window evidence.

```sh
mcp-fig service startup stage figma-launching --json
mcp-fig service startup action figma-launching open-figma background pending --json
# one background computer_use action
mcp-fig service startup progress figma-launching --json
mcp-fig service startup stage figma-ready --json
```

Do not repeatedly call open while the same `pending` action has no new process/window signal. The state machine returns the existing action without consuming an attempt.

Foreground delivery is allowed only after the preceding background result explicitly reports one of:

- `suspected_noop`
- `background_unavailable`
- `foreground_recommended`

Record that signal with the foreground action. Without it, the state pauses with `FOREGROUND_APPROVAL_REQUIRED` and consumes no attempt.

### 3. Locate and run the Plugin

Capture the current Figma menu tree rather than relying on coordinates. The expected path in the verified Desktop build is:

```text
Plugins > Development > MCP Fig Live Bridge
```

`Plugins > Run last plugin` is acceptable only when capture identifies the last Plugin as MCP Fig Live Bridge. Do not use it blindly.

```sh
mcp-fig service startup stage plugin-locating --json
# capture menu labels
mcp-fig service startup progress plugin-locating --json
mcp-fig service startup stage plugin-starting --json
# click the exact accessible menu item once, background delivery first
mcp-fig service startup action plugin-starting run-live-bridge background succeeded --json
```

If the Plugin window is already visible, do not run it again. Move directly to handshake verification.

### 4. Pair only at an approved boundary

The preferred Plugin UI shows **One-time pairing code**. If it already has a persisted pairing, it should reconnect without input.

If pairing is required:

1. Pause and obtain explicit user approval for this pairing attempt.
2. Generate a short-lived one-time code with `mcp-fig service pair`.
3. Enter only that one-time code in the **One-time pairing code** field.
4. Never expand or use **Manual development token** through automation.
5. Never type into a field labeled `Session token`, `Token`, `Credential`, `Password`, or similar.

If the visible UI exposes only a manual token field, stop with `PAIRING_UI_UNSAFE`; do not enter anything.

### 5. Verify the broker, not the UI label

```sh
mcp-fig service startup stage handshake-waiting --json
mcp-fig service status --json
```

Wait up to 30 seconds for stable success fields. A Plugin UI message such as “Ready” is not sufficient by itself.

When status confirms a session:

```sh
mcp-fig service startup verify --json
mcp-fig service status --json
```

The second status must report `startupState=verified`, a non-zero `pluginSessionCount`, connected `files`, and `lastHandshakeAt`.

## Failure evidence and fallback

| Condition | Evidence to preserve | Safe fallback |
| --- | --- | --- |
| Computer-use session ended | doctor output, driver status, ended session ID; no repeated actions | Idempotently revive the same driver session if the adapter supports it; otherwise pause for a new agent session |
| Accessibility/Screen Recording missing | doctor check name and result only | Ask the user to grant permission manually, then rerun doctor |
| Figma process exists but no window | process observation plus empty Figma window list | Check other Space/minimized windows; background focus first; no duplicate launch |
| Background action no-op | exact `suspected_noop`, `background_unavailable`, or foreground recommendation | One foreground attempt is allowed; otherwise pause |
| Figma menu changed | AX/menu capture lacks the expected labels | Use current accessible menu labels or ask the user to run the Plugin manually; never use stale coordinates |
| Plugin not installed | `Development` menu exists but MCP Fig Live Bridge is absent | Ask the user to import `plugin/manifest.json`; do not automate a permission/file dialog blindly |
| Plugin UI already visible | window capture | Do not run another instance; verify status |
| Only manual token UI is visible | field label evidence, with field contents omitted | Stop with `PAIRING_UI_UNSAFE`; reload/update the development Plugin or ask the user |
| Permission/password/keychain dialog | dialog role/title only; never capture field contents | Pause immediately and ask the user |
| Handshake timeout | service status, stage timestamps, Plugin window presence | Record one failed action; do not rotate credentials; retry only within the 3-attempt/lease policy |
| Circuit open | `attemptsUsed`, `lastStartupError`, `circuitOpenUntil` | Wait for cooldown or require an allowed reset signal |

Failure evidence must contain labels, stable codes, timestamps, and state changes only. Do not store screenshots containing one-time codes or any credential field value.

## Verification evidence from the 2026-07-27 implementation run

- `hermes computer-use doctor --json` passed all 8 reported checks on cua-driver 0.9.0, including Accessibility, Screen Recording, AX, and ScreenCaptureKit.
- Initial Hermes capture failed with `session 'hermes-8b7020d16ab8' has ended`; foreground escalation was not attempted.
- The running driver exposed idempotent `start_session`; reviving the same ID restored `capture_scope=auto`, `effective_scope=window`, and `desktop_unlocked=false`.
- A subsequent background Figma capture succeeded and exposed the Figma window, `Plugins`, `Development`, and an already-open MCP Fig Live Bridge window.
- The visible Plugin form exposed `Session token`; no token or credential was typed or read.
- Live `service status --json` initially reported `service=not_installed`, `pluginSessionCount=0`, `files=[]`, `lastHandshakeAt=null`, and actionable code `SERVICE_NOT_INSTALLED`.
- The documented safe action installed the per-user LaunchAgent. An immediate status observed the launch race as `SERVICE_UNAVAILABLE`; a read-only check two seconds later reported `service=running` and `PLUGIN_NOT_CONNECTED` without restarting or rotating credentials.
- The exact background `Run last plugin` click was rejected before dispatch because the same computer-use session ended again. The adapter did not enter an automatic revive/click loop; persistent status remained `paused` with `COMPUTER_USE_SESSION_ENDED`, while the daemon stayed running and credentials were untouched.
- No connection was claimed: final live status had `pluginSessionCount=0`, `files=[]`, and `lastHandshakeAt=null`.
- Automated integration tests separately verify a real daemon socket and HTTP Plugin handshake, stable status fields, `0600` startup state, timeout/lease/circuit behavior, existing-session idempotency, no duplicate launch, no blind foreground escalation, and GUI failure isolation from daemon credentials.
