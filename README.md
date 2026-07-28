# MCP Fig

A compact MCP server for structured Figma operations, persistent macOS Plugin connectivity, typed Auto Layout workflows, and bounded visual verification.

> Internal status: replacement-ready for the owner's Figma Design workflow on macOS. Distribution status: version `0.0.0`, private, unlicensed, and not ready for a public release.

## Replacement status

MCP Fig replaces the owner's routine Figma Console MCP workflow with ten typed core domain tools and an optional collaboration tool. The replacement decision is based on live Figma Desktop evidence, not only fixtures:

- exact local-file targeting, reconnect, and service recovery;
- node, text, image, component, instance, variable, style, and Auto Layout authoring;
- node export, Desktop screenshots, bounded audits, and pixel comparison;
- comment read, anchored post, and thread reply through the optional REST collaboration profile;
- a reviewed production-style page converted into reusable components, nested/root Auto Layout, and a separate 390px mobile design;
- zero Figma Console MCP, raw-execute, or browser mutation fallback during the replacement and reviewed-page dogfood gates.

The replacement does not claim Figma API parity. Raw arbitrary execution, FigJam, Slides, enabled-library inventory, comment edit/delete, Plugin annotations, version history, and console streaming are either intentionally excluded or still limited. See [the replacement capability matrix](docs/console-mcp-replacement.md).

## Quick start

Prerequisites: macOS, Node.js 20+, npm, Figma Desktop, and a safe file for development Plugin use.

### 1. Install and build

```bash
git clone https://github.com/uforgot/mcp-fig.git
cd mcp-fig
npm ci
npm run build
```

### 2. Install the per-user service

```bash
node dist/index.js service install
node dist/index.js service status --json
```

### 3. Start and pair the Figma Plugin once

Import `plugin/manifest.json` as a Figma development Plugin, then run **Plugins > Development > MCP Fig Live Bridge**. If pairing is requested, run:

```bash
node dist/index.js service pair
```

Enter only the short-lived one-time code in the Plugin. Confirm the connection with:

```bash
node dist/index.js service status --json
```

Success requires `service: "running"`, at least one Plugin session/file, and a non-null handshake time. Later Plugin launches reconnect from Figma `clientStorage`; the long-lived credential is not printed.

## Optional collaboration profile

Figma file comments are exposed only when the collaboration profile is enabled. A Figma REST access token is required because comments are not available through the Desktop Plugin API. Reading requires `file_comments:read`; posting and replying require `file_comments:write`.

```bash
MCP_FIG_PROFILES=core,collaboration \
FIGMA_ACCESS_TOKEN=... \
FIGMA_FILE_KEY=... \
node dist/index.js
```

Use `figma_collaboration(action: "comments")` to read comments or filter by `nodeIds`, `resolved`, and `limit`. Use `action: "post"` with an explicit file key, node ID, and node offset for a new anchored comment. Use `action: "reply"` with an explicit file key and root comment ID to reply on the original thread. Comment writes are not idempotent: if a request times out, read comments back before retrying. Figma exposes no endpoint for editing existing comment text; deletion is intentionally not implemented.

## Verification

The current automated suite is 28 test files / 197 tests. Release-class changes additionally require host and Plugin typechecks, lint, build, the real MCP stdio smoke, service/Plugin lifecycle smoke, and the relevant live Figma canary. Fixture success never claims live Figma rendering.

```bash
npm run typecheck
npm run typecheck:plugin
npm test
npm run lint
npm run build
npm run smoke
```

## Documentation

- [Console MCP replacement matrix and live evidence](docs/console-mcp-replacement.md)
- [Current handoff, verified paths, and known limits](docs/handoff.md)
- [Maintenance architecture and ownership](docs/maintenance.md)
- [Service lifecycle, security, and recovery](docs/service.md)
- [Agent-assisted Figma Plugin startup](docs/agent-startup.md)
- [Quality gates by change class](docs/quality-gates.md)
- [Bridge contract](docs/bridge-contract.md)
- [Auto Layout contract](docs/auto-layout-contract.md)
- [Design-system contract](docs/design-system-contract.md)
- [Trace logging and focused bug loop](docs/observability.md)

## Project status

MCP Fig exposes ten core domain tools plus the optional `figma_collaboration` tool. The default Desktop path uses one persistent per-user daemon and owner-only service IPC. It is the active internal replacement for the owner's Figma Design workflow, but it remains an early private project rather than a supported public package.

MCP Fig is an independent, unofficial project informed by existing Figma tooling, including [Figma Console MCP](https://github.com/southleft/figma-console-mcp). It is not affiliated with Figma. No license has been selected, so the repository is not licensed for reuse or redistribution.
