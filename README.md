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

Auto Layout will be treated as a first-class domain rather than a collection of low-level property edits.

Planned layout operations include:

- `inspect` — describe the current layout hierarchy and sizing rules.
- `apply` — set direction, spacing, padding, alignment, and wrapping.
- `sizing` — manage `HUG`, `FILL`, and `FIXED` behavior for parents and children.
- `batch` — apply related layout changes as one operation.
- `validate` — detect overflow, invalid sizing combinations, and conflicting constraints.
- `repair` — fix safe and deterministic layout problems.

Layout changes should be applied in dependency order: parent layout, parent dimensions, child sizing, constraints, then validation.

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
npm run typecheck
npm run lint
npm run build
npm run smoke
```

`npm run smoke` builds the server, starts `dist/index.js` over stdio, completes the MCP handshake, lists tools, and calls `figma_connection` with `action: "status"`.

Copy `.env.example` when you need local profile configuration. With no credentials, the server safely reports the bridge as `not-configured`. Setting `FIGMA_ACCESS_TOKEN` and `FIGMA_FILE_KEY` enables authenticated REST document and node reads. Current selection and all writes intentionally require a Desktop Plugin bridge; REST-only mode returns `UNSUPPORTED_BY_BRIDGE` instead of pretending a mutation succeeded.

The fixture adapter and `tests/fixtures/core-file.json` exercise create, update, move, resize, clone, delete preview, confirmation, and deletion through the same `FigmaBridge` contract. See [`docs/bridge-contract.md`](docs/bridge-contract.md).

Component, instance, and variable workflows are exposed through three additional facade tools. Local components remain node-addressed, library components remain key-addressed, and token aliases/modes are explicit. The required search → instance → property → binding flow is covered in five MCP calls. See [`docs/design-system-contract.md`](docs/design-system-contract.md).

## Contributing

The architecture and implementation tasks are tracked in the MCP Fig project backlog. Contribution guidelines will be added before the first public release.

## License

A license has not been selected yet. Until one is added, the repository is not licensed for reuse or redistribution.
