# Refactor handoff: baseline and module boundaries

## Scope and non-goal

This handoff fixes the baseline for a behavior-preserving split of three large implementation files. It does **not** authorize a new MCP tool, action, protocol field, capability, error shape, fixture behavior, or live write behavior. A complete live tool matrix is intentionally out of scope; the existing fixture suites and three focused live canaries remain the acceptance surface.

Baseline source commit: `8f609a0f5824214fa0869bff601471a1921b9ceb` (`main`, clean worktree before this document).

Baseline captured: `2026-07-25T20:14:24Z` with Node `v25.9.0` and npm `11.12.1`.

## Current responsibility map

### Plugin main sandbox

| Current file/range | Current responsibility | Target owner |
| --- | --- | --- |
| `plugin/main.js:1-257` | Revision/change state, cloning/canonicalization, scene traversal metrics, file identity, errors, node lookup/serialization, property validation, node construction | `plugin/src/core.js`, `plugin/src/node.js` |
| `plugin/main.js:258-466` | `document.*`, `selection.get`, `changes.get`, and `node.*` dispatch and mutations | `plugin/src/node.js` |
| `plugin/main.js:467-1060` | Auto Layout snapshots, apply/sizing, validation, preview/rollback, batch ordering, repair | `plugin/src/layout.js` |
| `plugin/main.js:1061-1199` | Local/library component lookup and component mutations | `plugin/src/component.js` |
| `plugin/main.js:1200-1257` | Component resolution and instance create/update/slot operations | `plugin/src/instance.js` |
| `plugin/main.js:1258-1368` | Variable collection/value/alias/mode operations and node bindings | `plugin/src/tokens.js` |
| `plugin/main.js:1369-1506` | Command validation, capability dispatch, idempotency result cache, metrics timestamps, UI message handling, document-change bootstrap | `plugin/src/runtime.js` |
| `plugin/ui.html` | Pairing UI, localhost HTTP client, reconnect loop, long-poll queue, UI ↔ main `postMessage` relay | Unchanged; outside this split |
| `plugin/manifest.json` | Figma entry points and localhost development-domain allowlist | Unchanged public packaging contract |

The line ranges describe commit `8f609a0`; they are evidence for extraction, not permanent ownership markers.

### Desktop Plugin bridge

| Current file/range | Current responsibility | Target owner |
| --- | --- | --- |
| `src/bridge/desktop-plugin.ts:1-253` | HTTP JSON helpers, token comparison, capability/read-write classification, canonical write metadata | `src/bridge/desktop-plugin/host-transport.ts`, `src/bridge/desktop-plugin/write-coordinator.ts` |
| `src/bridge/desktop-plugin.ts:254-1104` | Loopback host lifecycle, session registry/expiry, command queue, pending results, broker ownership/client forwarding, write serialization, revision/idempotency control, latency metrics | `host-transport.ts`, `session.ts`, `broker.ts`, `write-coordinator.ts`, `metrics.ts` |
| `src/bridge/desktop-plugin.ts:1105-1272` | `FigmaBridge` facade and typed method-to-protocol mapping | `src/bridge/desktop-plugin/facade.ts` |
| `src/bridge/plugin-protocol.ts` | Protocol v1 DTOs, capabilities, parsers, metric record shape | Remains the protocol contract below all Desktop modules |
| `src/bridge/factory.ts` | Runtime adapter selection and Desktop host/facade construction | Unchanged caller of the compatibility entry point |

### In-memory fixture bridge

| Current file/range | Current responsibility | Target owner |
| --- | --- | --- |
| `src/bridge/in-memory.ts:1-318` | Fixture cloning/tree lookup, file targeting, document/selection/change reads, generic node lifecycle | `src/bridge/in-memory/core.ts` |
| `src/bridge/in-memory.ts:319-464` | Auto Layout inspect/apply/sizing/batch/validate/repair and rollback | `src/bridge/in-memory/layout.ts` |
| `src/bridge/in-memory.ts:465-839` | Component, instance, token, variable collection, alias, binding, and slot behavior | `src/bridge/in-memory/design-system.ts` |
| `src/bridge/in-memory.ts:840-1106` | Private fixture state helpers, previews, file/revision/change bookkeeping, component/variable resolution | Move to `core.ts` unless exclusively used by `design-system.ts` |
| `src/bridge/layout.ts` | Shared deterministic layout normalization, validation, repair, ordering | Remains shared domain code; fixture layout delegates to it |
| `tests/fixtures/core-file.json` | Core and design-system fixture state | Unchanged fixture contract |
| `tests/fixtures/layout-invalid-file.json` | Invalid layout cases for validation/repair | Unchanged fixture contract |

## Public contract freeze

The refactor must preserve all of the following exactly.

### MCP facade

`src/server.ts` registers these eight tools and current actions:

| Tool | Frozen actions |
| --- | --- |
| `figma_connection` | `status`, `list_files`, `target`, `reconnect`, `capabilities` |
| `figma_document` | `inspect`, `summary`, `changes` |
| `figma_selection` | `get`, `inspect` |
| `figma_node` | `get`, `create`, `update`, `move`, `resize`, `clone`, `delete` |
| `figma_layout` | `inspect`, `apply`, `sizing`, `batch`, `validate`, `repair` |
| `figma_component` | `search`, `inspect`, `library_search`, `library_inspect`, `create_set`, `arrange_set`, `set_description`, `property_add`, `property_update`, `property_delete`, `slots`, `slot_create` |
| `figma_instance` | `create`, `update`, `slot_append`, `slot_reset` |
| `figma_tokens` | `inspect`, `apply`, `collection_create`, `collection_delete` |

The source of truth is the tool schemas in `src/tools/*.ts`; `tests/snapshots/core-tool-schemas.json` freezes their MCP-visible names, descriptions, annotations, fields, strict action branches, and tool count. `docs/api-design.md` and `docs/api-surface.json` include draft/future surface and must not be used to expand this refactor.

### Bridge and protocol

- `src/bridge/types.ts` remains the domain contract. `FigmaBridge`, its method signatures, action unions, node/layout/design-system DTOs, write controls, and status/change shapes are frozen.
- Existing import paths remain valid: `src/bridge/desktop-plugin.ts` continues to export `DesktopPluginBridgeHost` and `DesktopPluginFigmaBridge`; `src/bridge/in-memory.ts` continues to export `InMemoryFigmaBridge`. Built equivalents remain `dist/bridge/desktop-plugin.js` and `dist/bridge/in-memory.js`.
- Desktop protocol remains `mcp-fig-plugin/v1` with the existing eight capability strings in `src/bridge/plugin-protocol.ts` and `plugin/ui.html`.
- Pairing/authentication, loopback-only bind, request/client/session/file correlation, exact target checks, queue ordering, timeout behavior, revision conflict handling, idempotency, unknown-result handling, and bounded metrics retain current semantics.
- Reads may remain concurrent. Writes remain serialized per file. A dispatched write with an unknown result is never automatically retried.
- MCP success/error envelopes, error codes, retryability, dry-run previews, confirmation-token behavior, revision changes, and trace data remain byte-for-byte compatible where tests currently assert them.
- `plugin/manifest.json` continues to point at `plugin/main.js`; the development origin remains `http://localhost:3847` unless handled by a separate contract change.

## Target exact file map

Compatibility entry points stay in place. New internal files are implementation details and are not package exports.

```text
plugin/
  main.js                              # generated single-file Figma sandbox artifact; manifest path stays fixed
  src/
    main.js                            # bootstrap, dependency injection, command dispatch, UI message lifecycle
  runtime/
    identity.js                        # file key/name/revision projection
    revision.js                        # revision, change log, revision-keyed read cache, external-change tracking
    errors.js                          # structured bridge errors and explicit node-ID validation
    metrics.js                         # per-command scene traversal counter
    idempotency.js                     # canonical fingerprint, replay, conflict, bounded result cache
  domains/
    core-node.js                       # document/selection/change reads and generic node lifecycle
    layout.js                          # Auto Layout inspect/apply/sizing/batch/validate/repair
    component.js                       # component search/inspect/set/property/slot operations and resolver
    instance.js                        # instance create/update/slot operations
    tokens.js                          # collections, variables, modes, aliases, values, bindings
  shared/
    data.js                            # structured-clone-safe copy and canonical JSON
    node.js                            # node lookup/serialization/property validation/construction helpers

src/bridge/
  desktop-plugin.ts                    # compatibility re-export only
  desktop-plugin/
    host-transport.ts                  # loopback HTTP server, JSON/auth/CORS/routes only
    session.ts                         # handshake/session identity, heartbeat, expiry, file targeting, command queues
    broker.ts                          # host-owner discovery and secondary-process request forwarding
    write-coordinator.ts               # per-file serialization, revision checks, idempotency, unknown-outcome policy
    metrics.ts                         # bounded metric collection and timestamp/latency calculation
    facade.ts                          # DesktopPluginBridgeHost composition + DesktopPluginFigmaBridge mapping
  in-memory.ts                         # compatibility re-export only
  in-memory/
    core.ts                            # InMemory state, file/tree/node lifecycle, revision/change bookkeeping
    layout.ts                          # fixture Auto Layout behavior over core state
    design-system.ts                   # fixture component/instance/token behavior over core state
    facade.ts                          # composes and exports InMemoryFigmaBridge
```

`plugin/main.js` remains a self-contained Figma sandbox artifact because the current manifest/runtime does not establish an ES-module contract. `scripts/build-plugin.mjs` assembles the ordered source modules above without runtime imports or new dependencies. `npm run build:plugin` writes the artifact and `npm run check:plugin-bundle` rejects source/artifact drift. Tests continue to execute the shipped `plugin/main.js`; the manifest path is unchanged.

## Dependency direction

Allowed dependencies point inward/downward only:

```text
MCP tool schemas/handlers
  -> FigmaBridge contract (`src/bridge/types.ts`)
    -> adapter compatibility entry
      -> adapter facade/composition
        -> domain coordinators
          -> state/protocol primitives
```

Plugin rules:

```text
plugin/src/main.js
  -> runtime/{identity, revision, errors, metrics, idempotency}.js
  -> domains/{core-node, layout, component, instance, tokens}.js
  -> shared/{data, node}.js
```

- Domain modules do not import one another. The component resolver is injected into the instance domain by `plugin/src/main.js`.
- Runtime and shared modules know neither public command dispatch nor UI transport.
- `plugin/src/main.js` dispatches but contains no domain mutation rules.

Desktop rules:

```text
facade.ts -> {host-transport, session, broker, write-coordinator, metrics}.ts
host-transport.ts -> {session, broker} interfaces + plugin-protocol.ts
broker.ts -> session.ts + plugin-protocol.ts
write-coordinator.ts -> session.ts + plugin-protocol.ts
metrics.ts -> plugin-protocol.ts
```

- Transport does not decide revision/idempotency policy.
- Session storage does not perform HTTP or MCP facade mapping.
- Broker forwarding does not execute Plugin writes directly; it enters the same coordinator path as the owning host.
- Metrics observe completed operations and never alter queue outcomes.
- `facade.ts` is the only internal module that implements `FigmaBridge` or assembles the public host.

Fixture rules:

```text
facade.ts -> {core, layout, design-system}.ts
layout.ts -> core.ts + ../layout.ts
design-system.ts -> core.ts
core.ts -> ../types.ts + errors.ts only
```

`layout.ts` and `design-system.ts` may mutate fixture state only through explicit core primitives. They do not import each other or reach into private maps.

## Plugin extraction checkpoint

Item `1101` implements the Plugin boundary without changing `plugin/manifest.json`, `plugin/ui.html`, protocol capabilities, command names, or error strings.

| File | Owned responsibility |
| --- | --- |
| `plugin/runtime/identity.js` | Current file identity projected from Figma plus the revision runtime. |
| `plugin/runtime/revision.js` | Revision number, bounded change history, revision-keyed read cache, mutation/external-change invalidation. |
| `plugin/runtime/errors.js` | Structured bridge error creation and `nodeIds` assertion. |
| `plugin/runtime/metrics.js` | Active-command scene traversal count lifecycle. |
| `plugin/runtime/idempotency.js` | Canonical request fingerprint, replay-before-revision behavior, conflicting-key rejection, 1,000-entry eviction. |
| `plugin/shared/data.js` | Clone-safe serialization and canonical JSON normalization. |
| `plugin/shared/node.js` | Figma node lookup, serialization, property validation/application, supported node construction. |
| `plugin/domains/core-node.js` | Document, selection, change, and generic node commands. |
| `plugin/domains/layout.js` | Auto Layout inspect, validate, repair, preview, ordered batch, rollback. |
| `plugin/domains/component.js` | Component inventory and mutations; exports the resolver injected into the instance domain. |
| `plugin/domains/instance.js` | Instance create/update/reset and unsupported slot-append behavior. |
| `plugin/domains/tokens.js` | Variable collection, mode, value, alias, and binding commands. |
| `plugin/src/main.js` | Factory composition, command dispatch, result envelope, UI bootstrap/message handler, document/selection event wiring. |
| `scripts/build-plugin.mjs` | Fixed-order, dependency-free assembly into manifest-loaded `plugin/main.js`. |

Verification completed during extraction: generated-bundle drift check passed; Plugin checkJs passed; `tests/plugin-main.test.ts` and `tests/plugin-ui.test.ts` passed with 9/9 tests; Biome passed on 79 files.

Remaining risks:

- `plugin/main.js` is generated and committed. Every source edit must run `npm run build:plugin`; CI/review should also run `npm run check:plugin-bundle` so a stale artifact cannot ship.
- Source modules intentionally use injected factory dependencies rather than runtime imports. `plugin/main.js` is the only checkJs target because it is the executable global-script scope; isolated source files are linted and the assembled artifact is type checked.
- Layout remains the largest domain because validation, preview, dependency ordering, mutation, and rollback are one atomic behavior boundary. Splitting it further requires a separate item with targeted rollback/order tests.
- Live Desktop acceptance still depends on an explicit token and a paired disposable Figma file. Do not infer live success from the VM harness.

## Forbidden rules

1. No new public MCP tool or action; no profile expansion.
2. No schema snapshot update. A snapshot diff means the refactor changed the public contract and must stop.
3. No protocol version/capability/endpoint/payload change and no Plugin UI or manifest behavior change.
4. No change to error codes/messages, result envelopes, revision increments, confirmation TTL/consumption, idempotency semantics, timeout semantics, queue ordering, or cleanup behavior.
5. No raw Figma execution escape hatch and no write fallback from Desktop Plugin to REST.
6. No adapter-specific type leaking into `src/tools/*` or `FigmaBridge` callers.
7. No circular dependency and no sibling-domain import hidden behind dynamic import.
8. No broad formatting, renaming, or unrelated cleanup while moving code.
9. No fixture-only shortcut that claims live Figma rendering or changes fixture JSON to make tests pass.
10. No all-tool live matrix. Keep live acceptance to the existing canaries below.
11. No extraction commit that leaves both old and new implementations active. Compatibility files may re-export, not duplicate logic.
12. No bundler/toolchain choice that changes shipped entry paths or introduces runtime network/package dependencies.

## Pre-refactor baseline

At commit `8f609a0`, this exact command passed:

```bash
npm run typecheck && npm test && npm run lint && npm run build
```

Observed result:

- TypeScript no-emit typecheck: pass.
- Vitest: 12 files passed, 54 tests passed.
- Biome: 65 files checked, no fixes applied.
- TypeScript build: pass; `dist/` emitted successfully.

### Existing live canary acceptance

These are required before and after extraction when a paired disposable Figma Desktop file and token are available:

| Command | Frozen acceptance |
| --- | --- |
| `npm run canary:plugin` | Pair; read document and selection; create and rename a frame; apply and validate Auto Layout; read the node back; print `passed: true`; intentionally retain one `MCP Fig Live Canary - PASS` frame. |
| `npm run canary:reconnect` | Pair; stop/restart the host; recover the same file; read selection/document; create/read back/delete a frame; print `passed: true`, `readAfterReconnect: true`, `writeAfterReconnect: true`, `cleanup: true`. |
| `npm run canary:multi-agent` | Ten separate Node processes receive isolated responses; same-revision writes yield exactly one winner and one `REVISION_CONFLICT`; duplicate idempotency key executes one mutation and returns the same result; final readback and cleanup pass. |

Live canaries were **not rerun while capturing this document**: the shell had no `MCP_FIG_PLUGIN_TOKEN` or `MCP_FIG_PLUGIN_FILE_KEY`, and no process was listening on TCP `3847`. This is an explicit environment limitation, not a passing live result. The next extraction item must attach real `passed: true` output from all three canaries or remain blocked from review.

## Next-item handoff

Execute one boundary at a time; do not split all three large files in one commit.

1. **Plugin extraction — completed by item `1101`**
   - `plugin/runtime`, `plugin/domains`, and `plugin/shared` own the extracted behavior; `plugin/src/main.js` owns composition/dispatch/UI lifecycle.
   - `scripts/build-plugin.mjs` keeps `plugin/main.js` as the deterministic shipped artifact, and Plugin tests execute that artifact.
   - Any follow-up must preserve the checkpoint and remaining-risk notes above.
2. **Desktop host extraction**
   - Preserve `src/bridge/desktop-plugin.ts` as the compatibility entry.
   - Extract pure metrics/write metadata first, then session, coordinator, broker, and HTTP transport; move facade composition last.
   - After each move run `tests/desktop-plugin-bridge.test.ts`, `scripts/smoke-plugin-bridge.mjs`, and `scripts/smoke-process-lifecycle.mjs` through their npm script/build path.
3. **Fixture extraction**
   - Preserve `src/bridge/in-memory.ts` as the compatibility entry.
   - Extract core state primitives, then layout, then design-system behavior; keep `src/bridge/layout.ts` shared.
   - Run core, layout, layout-validation, design-system, and quality-gate tests after each domain move.
4. **Final acceptance for every extraction commit**
   - Confirm `git diff -- tests/snapshots/core-tool-schemas.json` is empty.
   - Run `npm run typecheck && npm test && npm run lint && npm run build`.
   - Run `npm run smoke` and `npm run smoke:plugin` for the built artifacts.
   - With the live prerequisites present, run the three frozen canaries and retain their JSON evidence.
   - Stage only the boundary being reviewed and commit atomically.

Stop and open a separate contract task if any extraction requires a new action, altered schema/protocol, changed live semantics, or a manifest/UI transport change.
