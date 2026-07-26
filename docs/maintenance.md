# Maintenance guide

This document is the ownership map for behavior-preserving maintenance. Do not rebuild the pre-refactor large files, add a second broker, or make manual tokens the normal user path.

## Runtime architecture

```text
MCP client
  -> src/server.ts + src/tools/*
  -> FigmaBridge contract (src/bridge/types.ts)
  -> src/bridge/factory.ts
     -> default macOS path: ServiceClient over owner-only Unix socket
     -> explicit manual development path: DesktopPluginBridgeHost in process
     -> REST read-only path
     -> disconnected path

ServiceClient
  -> mcp-fig-service/v1
  -> BrokerDaemon
  -> one DesktopPluginBridgeHost
  -> mcp-fig-plugin/v1 over 127.0.0.1
  -> Plugin UI transport
  -> generated plugin/main.js
  -> Figma Plugin API
```

The persistent daemon is the only production owner of Plugin HTTP transport, sessions, file identity, pending requests, per-file write serialization, revisions, idempotency, and unknown-outcome policy. MCP stdio processes are clients; they must not bind a fallback host when service mode is unavailable.

## Module ownership

### MCP and contracts

| Owner | Responsibility |
| --- | --- |
| `src/server.ts` | Registers the eight current public tools. |
| `src/tools/*` | MCP-visible schemas, action validation, confirmation boundaries, and facade calls. |
| `src/bridge/types.ts` | Adapter-neutral `FigmaBridge` contract and domain DTOs. |
| `src/bridge/plugin-protocol.ts` | `mcp-fig-plugin/v1`, capabilities, command/result correlation, and metrics DTOs. |
| `src/service/protocol.ts` | `mcp-fig-service/v1` IPC methods, envelopes, parsing, and correlation. |

### Persistent service and Desktop bridge

| Owner | Responsibility |
| --- | --- |
| `src/service/daemon.ts` | One broker daemon, Unix-socket request handling, host composition, drain, and shutdown. |
| `src/service/client.ts` | Isolated service requests and conservative read/write error mapping. |
| `src/service/{socket,paths,credential,launchd,cli}.ts` | Owner-only storage/socket, credentials/pairing, LaunchAgent lifecycle, and operator CLI. |
| `src/service/{startup-state,agent-status}.ts` | Persistent bounded GUI-startup state and stable agent-readable status. |
| `src/bridge/desktop-plugin/host.ts` | HTTP/session/coordinator composition and single listener ownership. |
| `src/bridge/desktop-plugin/http.ts` | Loopback HTTP, auth/CORS, pairing route, Plugin polling/result routes, and waiter cleanup. |
| `src/bridge/desktop-plugin/sessions.ts` | Session registry, file targeting, heartbeat/TTL, command queues, and live waiter state. |
| `src/bridge/desktop-plugin/write-coordinator.ts` | Pending correlation, per-file writes, revision/idempotency checks, timeouts, unknown outcomes, and bounded metrics. |
| `src/bridge/desktop-plugin/facade.ts` | Typed `FigmaBridge` method-to-protocol mapping. |
| `src/bridge/desktop-plugin.ts` | Compatibility exports only. |

### Figma Plugin

`plugin/main.js` is generated and remains the manifest-loaded single artifact. Edit its owners, then rebuild it:

- `plugin/runtime/*`: identity, revision/change tracking, errors, metrics, idempotency.
- `plugin/domains/*`: core node, layout, component, instance, and token actions.
- `plugin/shared/*`: clone/canonical data and node helpers.
- `plugin/src/main.js`: composition, dispatch, result envelope, UI lifecycle, and event wiring.
- `scripts/build-plugin.mjs`: deterministic assembly; `npm run check:plugin-bundle` rejects drift.

Domain modules do not import sibling domains. Cross-domain capabilities are injected by composition.

### In-memory fixture

- `src/bridge/in-memory/store.ts`: fixture files/nodes, clone/find utilities, IDs, revisions, and change records.
- `src/bridge/in-memory/core.ts`: connection, document, selection, and generic node actions.
- `src/bridge/in-memory/layout.ts`: fixture layout behavior over store primitives and shared `src/bridge/layout.ts` logic.
- `src/bridge/in-memory/design-system.ts`: component, instance, and token actions.
- `src/bridge/in-memory.ts`: composition and compatibility facade only.

Fixtures prove deterministic contract behavior. They do not prove Figma rendering, Plugin startup, localhost transport, launchd recovery, or multi-process coordination.

## Dependency direction

```text
tools -> FigmaBridge contract -> adapter facade -> domain/state primitives
ServiceClient -> service protocol + socket
BrokerDaemon -> Desktop host -> HTTP/sessions/write coordinator -> Plugin protocol
Plugin composition -> runtime/domains/shared
Fixture composition -> core/layout/design-system -> store
```

Keep dependencies one way. Do not let tools import adapter internals, domains import siblings, the service duplicate write coordination, or fixtures claim live success.

## Public contract change procedure

A pure refactor must leave public schemas, protocol versions, capabilities, error semantics, revision behavior, idempotency, and snapshots unchanged. If a change is intentional:

1. Open a separate contract task; do not hide it inside maintenance.
2. Update `src/bridge/types.ts` and the exact `src/tools/*` schema owner.
3. Update Plugin and/or service protocol versions only when compatibility actually changes; update every parser, producer, consumer, and error path together.
4. Add failing contract tests first. Preserve replay-before-revision ordering and never retry an unknown write.
5. For Plugin source changes, run `npm run build:plugin` and commit the generated `plugin/main.js`; verify `npm run check:plugin-bundle`.
6. Update snapshots only with `npm run snapshots:update`, review the JSON diff, and record why compatibility changed.
7. Run the category gate in [`quality-gates.md`](quality-gates.md), then the full gate.
8. Update the relevant contract and handoff documents with only observed behavior.

## Trace-driven fix loop

One `traceId` follows MCP tool handling through service IPC, daemon routing, Plugin dispatch, and Figma API result. Allowed event fields and redaction rules live in [`observability.md`](observability.md).

1. Capture the redacted event chain and exact user-visible failure.
2. Reproduce only the failing method/action and preconditions.
3. Add the smallest deterministic failing regression test and observe RED.
4. Patch the narrow owner; do not broaden into a refactor.
5. Run the focused test plus adjacent correlation/redaction tests.
6. Run only the live canary matching the changed boundary.
7. Record actual output and cleanup. Do not invent benchmark or live evidence.

Generate a report with:

```bash
npm run bug:report -- --trace <trace-id> --log <events.jsonl>
```

The report never fixes, commits, or pushes code automatically.
