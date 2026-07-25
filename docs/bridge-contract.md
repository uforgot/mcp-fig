# Figma bridge contract

## Purpose

MCP Fig keeps its public MCP tools independent from any one Figma transport. Domain tools call `FigmaBridge`; adapters decide whether data comes from Figma REST, a Desktop Plugin connection, or a deterministic fixture.

## Responsibility boundary

| Capability | REST adapter | Desktop Plugin adapter | Fixture adapter |
|---|---:|---:|---:|
| File metadata and published document reads | Primary | Fallback/live context | Test implementation |
| Node reads by ID | Supported | Supported | Supported |
| Current selection | Not available | Primary | Supported |
| Node create/update/move/resize/clone/delete | Not available | Primary | Supported |
| Local unsaved state | Not available | Primary | Supported |
| Deterministic integration tests | No | No | Primary |

The facade chooses an adapter; callers do not select REST or Plugin API per action. Runtime capability discovery reports `readSource` and `writeSource` so the server does not claim write support when only REST is configured.

## Core interface

`src/bridge/types.ts` defines:

- connection status, file listing, file targeting, and reconnect
- document, selection, change, and node reads
- typed node lifecycle mutations
- bridge mode and explicit read/write sources

`DisconnectedFigmaBridge` is the safe default. It reports health honestly and returns `NOT_CONNECTED` for document or node operations. `RestFigmaBridge` provides authenticated Figma REST document, version, and node reads while explicitly rejecting selection and writes. `InMemoryFigmaBridge` implements the full contract for fixture integration tests without pretending that a live Figma connection exists.

`DesktopPluginFigmaBridge` is enabled with `MCP_FIG_PLUGIN_TOKEN`. Its host binds to `127.0.0.1` only and uses protocol `mcp-fig-plugin/v1`. The Plugin UI owns HTTP transport because the Figma main sandbox cannot access localhost directly; UI and main exchange typed commands with `postMessage`.

## Desktop Plugin protocol v1

- Pairing handshake: protocol, session ID, plugin client ID, active file key/name/revision, capabilities, and client timestamp.
- Command: request/client/session/file correlation, typed method and params, created/dispatched timestamps.
- Result: the same correlation tuple, success data or structured error, received/completed timestamps.
- Security: bearer session token, loopback-only bind, exact file target checks, and rejection of unknown or mismatched results.
- Connection state: connected/disconnected host records, reconnecting Plugin UI backoff, heartbeat/long-poll last-seen tracking, reusable session identity, expiring sessions, and retryable `NOT_CONNECTED` errors.
- Metrics: bounded in-memory queue/plugin/total latency records for the benchmark task.

One Plugin UI processes its queue sequentially, so concurrent callers cannot consume each other's results. Cross-agent write conflict/revision policy and repeated stress proof remain the explicit follow-up scope rather than an unverified MVP claim.

## Mutation safety

- Every mutation requires an explicit `action`.
- Multi-node actions require a non-empty `nodeIds` array.
- Layout properties are intentionally absent from the generic node patch and belong to `figma_layout`.
- Delete is a two-step operation: `dryRun: true` returns a short-lived token bound to the file and exact target IDs; apply consumes that token once.
- Bridge/business errors use MCP Fig's common error envelope. JSON Schema failures remain standard MCP `-32602` errors and never reach a bridge.

## Adapter implementation rules

A live hybrid adapter should:

1. Use REST for stable remote reads where possible.
2. Use the Desktop Plugin connection for current selection, unsaved state, and all writes.
3. Return `UNSUPPORTED_BY_BRIDGE` when the active adapter cannot perform an action.
4. Never silently downgrade a write to raw execution.
5. Preserve target file and revision information for future optimistic concurrency checks.
