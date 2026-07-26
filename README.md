# MCP Fig

A streamlined MCP server for Figma with an organized tool surface and reliable Auto Layout support.

> **Status:** Early development. Connection and Core node foundations are implemented, but MCP Fig is not ready for production use yet.

## Why MCP Fig?

Full-featured Figma MCP servers can expose more than 100 tools. That breadth is useful, but it can also make tool selection harder for AI models, increase prompt overhead, and require extra calls for common design operations.

MCP Fig aims to keep Figma automation capable while making its interface smaller, clearer, and more predictable.

## Goals

- Reduce the default MCP tool surface to approximately 12–15 domain-oriented tools.
- Keep advanced capabilities available through optional tool profiles instead of removing them.
- Improve Auto Layout creation, inspection, validation, and repair.
- Reduce the need for arbitrary plugin scripts during normal design work.
- Make common Figma operations possible with fewer tool calls.
- Validate visual changes with structured checks and screenshots.

## Design Principles

### Small default surface

Expose a compact set of tools by default. Group related operations behind explicit actions instead of publishing a separate tool for every command.

### Domain-oriented tools

Avoid both extremes: hundreds of tiny tools and one oversized tool with an unmanageable schema. Organize tools by stable Figma domains such as nodes, layouts, components, instances, tokens, and audits.

### Progressive capabilities

Keep the default profile focused. Enable specialized profiles only when a task needs them, such as variables, libraries, collaboration, Slides, FigJam, or development utilities.

### Structured operations first

Use typed and validated operations for normal work. Keep raw Figma Plugin API execution as an advanced fallback rather than the primary editing method.

### Inspect, change, verify

Every complex modification should follow a predictable flow:

1. Inspect the current document state.
2. Apply the smallest required change.
3. Validate layout and sizing constraints.
4. Capture a screenshot when visual verification is needed.

## Planned Core Tools

The initial core profile is expected to cover these domains:

- Connection
- Document
- Selection
- Node
- Layout
- Component
- Instance
- Tokens
- Styles
- Annotation
- Screenshot
- Audit
- Advanced execution fallback

The final API will be defined after auditing real Figma workflows and measuring tool usage.

## Auto Layout Direction

Auto Layout is treated as a first-class domain rather than a collection of low-level property edits.

Implemented layout operations:

- `inspect` — describe the current layout hierarchy and sizing rules.
- `apply` — set direction, spacing, padding, alignment, and wrapping.
- `sizing` — manage `HUG`, `FILL`, and `FIXED` behavior for parents and children.
- `batch` — atomically apply related layout changes in dependency order.
- `validate` — detect overflow, invalid sizing combinations, and conflicting bounds.
- `repair` — change only safe HUG/FILL conflicts to `FIXED`, with dry-run and post-repair validation.

Layout changes are applied in dependency order: parent layout, child sizing, then constraints. Repairs reject any issue that requires design intent and commit only after revalidation. See [`docs/auto-layout-contract.md`](docs/auto-layout-contract.md) for the typed schema, diagnostics, preview, and rollback contract.

## Tool Profiles

Planned profiles:

- `core` — everyday reading, editing, components, layout, and verification
- `tokens` — variables and token import/export
- `libraries` — published components and library assets
- `collaboration` — comments, versions, and change history
- `slides` — Figma Slides operations
- `figjam` — FigJam operations
- `advanced` — diagnostics and raw plugin execution

Only the core profile should be enabled by default.

## Success Criteria

- No more than 15 tools exposed in the default profile.
- Common design tasks completed in five tool calls or fewer.
- At least 90% of normal Auto Layout work completed without raw execution.
- Invalid `HUG`, `FILL`, and `FIXED` combinations detected before completion.
- Layout changes verified through structured validation and visual inspection.
- Advanced functionality remains available without bloating the default context.

## Roadmap

1. Audit existing Figma MCP tools and common workflows.
2. Define the compact domain API and tool profiles.
3. Implement the Figma connection and core node operations.
4. Build first-class Auto Layout operations.
5. Add validation, screenshots, and workflow tests.
6. Introduce optional advanced profiles.
7. Publish setup documentation and an initial release.

## Project Relationship

MCP Fig is an independent project informed by experience with existing Figma MCP implementations, including [Figma Console MCP](https://github.com/southleft/figma-console-mcp). It is not affiliated with Figma or the Figma Console MCP project.

If source code is later adapted from another project, its license and attribution requirements will be preserved.

## Development

Prerequisites: Node.js 20+ and npm.

```bash
npm install
npm test
npm run quality
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run smoke:plugin
```

`npm run smoke` builds the server, starts `dist/index.js` over stdio, completes the MCP handshake, lists tools, and calls `figma_connection` with `action: "status"`. `npm run smoke:plugin` also starts the built stdio artifact with a loopback host, pairs a deterministic fake Plugin transport, then round-trips selection inspection, node update, and Auto Layout repair.

`npm run quality` executes the compact-surface, schema snapshot, workflow call-budget, typed Auto Layout, and structural visual regression gates. The current fixture baseline is 8 core tools, 12/12 successful representative workflows, no more than 5 calls per workflow, and 10/10 Auto Layout workflows without raw execution. See [`docs/quality-gates.md`](docs/quality-gates.md).

Copy `.env.example` when you need local profile configuration. With no credentials, the server safely reports the bridge as `not-configured`. Setting `FIGMA_ACCESS_TOKEN` and `FIGMA_FILE_KEY` enables authenticated REST document and node reads. REST-only mode returns `UNSUPPORTED_BY_BRIDGE` instead of pretending a mutation succeeded.

### Persistent Desktop Plugin service (macOS)

Build the repository, then install the foreground broker as a per-user LaunchAgent:

```bash
npm run build
node dist/index.js service install
node dist/index.js service status
```

An installed package exposes the same commands as `mcp-fig service <command>`:

```text
install | start | stop | restart | status | logs | uninstall | rotate | pair
```

Calling `mcp-fig` with no arguments remains the MCP stdio entry. Desktop mode connects to the persistent service by default; it does not silently create an in-process broker when the daemon is unavailable.

Installation writes `~/Library/LaunchAgents/com.uforgot.mcp-fig.plist` with `RunAtLoad`, crash-only `KeepAlive`, a 10-second restart throttle, absolute executable/script paths, and stdout/stderr log paths. Lifecycle starts and restarts rotate logs over 1 MB with three backups. The Plugin credential and service config live under `~/Library/Application Support/mcp-fig` with a `0700` directory and `0600` files. The credential is read by the daemon from disk: it is not placed in the plist, process arguments, environment, status, stdout, or logs. `service rotate` replaces it without printing it and restarts a loaded service. `service logs` redacts the current credential defensively. `service uninstall` removes only MCP Fig service files and does not delete Figma documents or Plugin `clientStorage`.

`service pair` prints a random one-time code that expires after two minutes. Only its SHA-256 digest is stored, and successful exchange consumes it atomically. Enter the code in the Plugin once: the localhost/null-origin exchange returns the long-lived credential directly to the Plugin UI, which stores it in Figma `clientStorage` without rendering or logging it. Later Plugin launches reconnect automatically. **Forget** clears the saved config; **Re-pair** is required after `service rotate` invalidates the old credential.

Each MCP tool call now carries one `traceId` through service IPC, Plugin dispatch, and the Figma API result. Daemon events go to stderr; rotating JSONL is opt-in through `MCP_FIG_EVENT_LOG`, and MCP stdio stdout remains protocol-only. Generate a redacted focused report with `npm run bug:report -- --trace <id> --log <events.jsonl>`. See [`docs/observability.md`](docs/observability.md) for the schema, forbidden fields, and capture → reproduce → failing test → minimal fix → focused test → live canary loop.

For direct development canaries, set `MCP_FIG_DESKTOP_MODE=manual` and `MCP_FIG_PLUGIN_TOKEN` explicitly. The default port is `3847`; the host binds only to `127.0.0.1`, while the Plugin connects through `http://localhost:3847` because Figma's development-domain validator does not accept the loopback IP literal. If you choose another port, add the matching `http://localhost:<port>` origin to `plugin/manifest.json` `devAllowedDomains` before importing the development plugin.

In manual mode, import `plugin/manifest.json` as a development plugin, run **MCP Fig Live Bridge**, and use the **Manual development token** form with the matching port and token. Optionally set `MCP_FIG_PLUGIN_FILE_KEY` to pin the MCP process to one paired file. Each command and result validates token, request ID, client ID, session ID, and file key before a response can resolve.

The persistent daemon owns the only Plugin HTTP host, session registry, and per-file write coordinator. Multiple MCP stdio processes connect over its owner-only `0600` Unix socket. Reads remain concurrent; writes are serialized per file with optional `expectedRevision` and `idempotencyKey` controls. A dispatched write with an unknown result is never retried automatically.

For a disposable blank Figma draft, run `npm run canary:plugin`. After the Plugin pairs, the script reads live selection, creates and renames a frame, applies Auto Layout, validates it, and prints the verified node. It intentionally leaves one `MCP Fig Live Canary - PASS` frame as visible evidence. Run `npm run canary:reconnect` for host restart recovery or `npm run canary:multi-agent` for 10 separate Node processes sharing one broker; the multi-agent canary verifies response isolation, one-winner revision conflict handling, idempotent retry, readback, and cleanup.

Protocol v1 routes typed facade actions through `stdio MCP → owner-only service IPC → 127.0.0.1 daemon host → Plugin UI → Plugin main`. It supports current selection/document/node reads, core node mutations, Component/Instance/Token actions, and Auto Layout inspect/apply/sizing/batch/validate/repair. It does not expose raw Plugin API execution. Timing metrics retain created/dispatched/received/completed timestamps and request/client/session/file correlation for the dedicated benchmark and concurrency follow-ups.

The fixture adapter and `tests/fixtures/core-file.json` exercise create, update, move, resize, clone, delete preview, confirmation, and deletion through the same `FigmaBridge` contract. See [`docs/bridge-contract.md`](docs/bridge-contract.md).

Component, instance, and variable workflows are exposed through three additional facade tools. Local components remain node-addressed, library components remain key-addressed, and token aliases/modes are explicit. The required search → instance → property → binding flow is covered in five MCP calls. See [`docs/design-system-contract.md`](docs/design-system-contract.md).

## Contributing

The architecture and implementation tasks are tracked in the MCP Fig project backlog. Contribution guidelines will be added before the first public release.

## License

A license has not been selected yet. Until one is added, the repository is not licensed for reuse or redistribution.
