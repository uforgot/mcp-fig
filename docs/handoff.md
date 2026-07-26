# Current handoff

## Current state

MCP Fig exposes eight MCP tools through one adapter-neutral `FigmaBridge` contract. The normal macOS write path is MCP stdio -> owner-only service IPC -> one persistent daemon -> Plugin UI transport -> generated Plugin sandbox -> Figma API.

The former large Plugin, Desktop bridge, and fixture implementations are split by ownership. Compatibility entries remain at `plugin/main.js`, `src/bridge/desktop-plugin.ts`, and `src/bridge/in-memory.ts`; do not move behavior back into them.

The installed service uses a per-user LaunchAgent, an owner-only Unix socket, one-time pairing, Plugin `clientStorage` reconnect, per-file write serialization, revision checks, idempotency, non-retried unknown outcomes, and correlated redacted events. Agent-assisted Figma startup is a bounded best-effort adapter; it is not part of daemon ownership.

## Live paths actually passed

Item `1110` ran these paths against a disposable local Figma Draft through the production LaunchAgent:

- fresh service install and one-time pairing;
- saved reconnect after service restart, fresh MCP process, and explicit Plugin restart with no port/token re-entry;
- live selection/document read, frame create/update/readback/delete, and cleanup;
- ten separate client processes with isolated responses;
- one winner and one `REVISION_CONFLICT` for same-revision writes;
- one mutation for duplicate idempotency nonce;
- non-retryable `UNKNOWN_OUTCOME` with no automatic write retry;
- one owner of TCP `3847` and zero remaining matching canary nodes.

The canaries in `scripts/live-plugin-canary.mjs`, `live-reconnect-canary.mjs`, and `live-multi-agent-canary.mjs` use service IPC. They do not create a second Plugin host or require a manual token.

At `2026-07-26T23:07:52Z`, item `1105` reran `npm run canary:plugin` against the connected `Untitled` local Draft. It reported `transport=persistent-service-ipc`, selection/read/write/readback all true, and `cleanup=true`. The same item ran the bug-report CLI against a temporary two-event redacted trace; the output mode was `0600`, both events matched, the focused fix loop was present, and injected forbidden fields were absent.

The same item built the documentation commit from a detached clean worktree with fresh `npm ci`, then exercised the production user service through uninstall, install, logs, rotate, stop, start, restart, uninstall, and a final install from the stable repository path. Final checks found one port `3847` owner, expected `0700` directories and `0600` files/socket, no credential in plist/process/status/log output, and a running service. Credential replacement intentionally left the Plugin disconnected; pairing was not automated without explicit approval.

Static and local integration coverage includes generated Plugin drift checking, service IPC, temporary real launchd bootstrap/crash recovery, owner and mode checks, secret scans, process lifecycle, fixture domains, trace correlation/redaction, and startup-state behavior. See [`quality-gates.md`](quality-gates.md) for the minimum command by change class.

## Not verified

Do not infer these from fixture or local smoke tests:

- cloud-file lifecycle behavior; the live acceptance used local Draft key `local:0:0`;
- unattended Plugin startup while Figma is closed or no safe document is open;
- pixel/visual correctness of every mutation; fixture structural assertions are not rendered screenshots;
- a complete live matrix for every tool/action;
- external-user package installation, MCP client configuration, profile selection, or release packaging;
- long-duration daemon soak, sleep/wake, multiple macOS accounts, or non-macOS service management.

## Known limits

- launchd can keep the daemon alive but cannot force Figma to run a development Plugin. The Plugin must run in an open safe file, manually or through the bounded startup adapter.
- Figma development hot reload can briefly leave stale same-file sessions until TTL expiry. Routing selects the latest ready session.
- Agent startup must stop at permission/password dialogs and manual-token-only UI. Automated pairing can enter only a one-time code after explicit user approval.
- `src/service/startup-state.ts` currently enforces stage inactivity budgets of 90 seconds for Figma launch, 60 seconds for Plugin location, 60 seconds for Plugin start, and 30 seconds for handshake. Dudu item `1109` later states 180/90/90/60 seconds; the implementation and request are inconsistent. This document records the implemented values. Resolve the policy in a separate task before changing code or docs.
- `service stop` boots out the launchd label, and current `service status` reports that state as `not_installed` even though retained config can be loaded by `service start`.
- The project remains version `0.0.0`, private, and unlicensed for reuse. It is not a release candidate.

## Next priorities

1. Resolve the startup-budget contract mismatch with focused tests and an explicit policy decision.
2. Keep dogfood failures in the trace -> reproduce -> failing test -> minimal fix -> focused test -> relevant canary loop.
3. Complete release task `#1076`. Its remaining blockers are setup documentation for external users, MCP client configuration examples, profile guidance, contribution rules, a license decision, changelog/release notes, an initial release candidate, and a fresh external-environment install/connect/sample-operation verification.
4. Add broader live coverage only from observed failures or release requirements; do not create an all-tool live matrix by default.

## Start here

- Architecture and change ownership: [`maintenance.md`](maintenance.md)
- Service operations and recovery: [`service.md`](service.md)
- Agent-assisted Plugin startup: [`agent-startup.md`](agent-startup.md)
- Minimum verification by change class: [`quality-gates.md`](quality-gates.md)
- Trace and bug report loop: [`observability.md`](observability.md)
