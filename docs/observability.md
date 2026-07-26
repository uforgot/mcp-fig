# Trace event log and focused bug loop

MCP Fig assigns one `traceId` at the MCP tool boundary and carries it through the service request, daemon IPC, Plugin command, Plugin main result, and daemon-side Figma API result event. The same trace ID is returned in the MCP tool response so a dogfood failure can be collected without searching payload contents.

## Event schema

`src/observability/event-log.ts` accepts only these fields:

- `timestamp`, `level`, `traceId`, `requestId`, `clientId`, `daemonPid`
- `sessionId`, `fileKey`, `method`, `action`, `targetNodeIds`, `revision`
- `errorCode`, `latencyMs`, `retryable`

Unknown fields are discarded. Malformed events become a payload-free `event.invalid` record. Strings and target lists are bounded and control characters are removed.

Never add token, Authorization, pairing code/credential, raw Unix-socket payload, request params, command/result data, or full document payload fields. Unknown write outcomes remain `UNKNOWN_OUTCOME` with `retryable=false`; logging must not turn them into success or trigger a retry.

## Destinations

The foreground daemon writes one JSON event per line to **stderr**. MCP stdio stdout remains protocol-only and receives no event log lines.

A rotating JSONL destination is opt-in:

```bash
MCP_FIG_EVENT_LOG="$HOME/Library/Logs/mcp-fig/events.jsonl" mcp-fig service run
```

The JSONL file is `0600`, rejects symlinks/foreign owners/group or other access, rotates at 1 MB, and keeps three backups. The LaunchAgent plist does not contain this path or any credential. For a launchd-run service, set the non-secret variable in the user launchd environment before restart, or run a foreground canary with the variable explicitly set.

Recorded lifecycle actions include:

- `daemon.start` / `daemon.stop`
- `plugin.handshake`
- `ipc.connect` / `ipc.disconnect`
- `waiter.open` / `waiter.close`
- `dispatch`
- `figma.api.result`
- `service.request` / `service.error`
- `unknown_outcome`

## Generate a bug report

```bash
npm run bug:report -- \
  --trace <trace-id> \
  --log "$HOME/Library/Logs/mcp-fig/events.jsonl"
```

You can filter a class of failures instead:

```bash
npm run bug:report -- --error-code UNKNOWN_OUTCOME --log /path/to/events.jsonl
```

The script reads the current log and available `.1`–`.3` rotations, parses each line independently, reapplies the event whitelist, skips malformed lines, and writes an owner-only report:

```text
bugs/YYYY-MM-DD-<traceId>.md
```

The script does **not** modify source, run an automated fix, commit, or push.

## Focused regression fix loop

1. **Capture** — preserve the redacted trace and exact user-visible failure.
2. **Reproduce** — reproduce only the failing method/action with the same target and revision preconditions.
3. **Failing test** — add the smallest deterministic regression test and observe the intended RED failure.
4. **Minimal fix** — patch the narrow owner. Do not retry or mark unknown writes successful.
5. **Focused test** — rerun the failing test plus adjacent correlation/redaction tests.
6. **Relevant live canary** — run only the canary matching the touched boundary and record actual output.

Do not begin a broad refactor from a bug report. The report is evidence for a focused loop, not an automatic repair instruction.
