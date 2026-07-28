# MCP Fig

A compact MCP server for structured Figma operations, persistent macOS Plugin connectivity, and typed Auto Layout workflows.

> Early development: version `0.0.0`, private, and not ready for production release.

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

## Documentation

- [Maintenance architecture and ownership](docs/maintenance.md)
- [Service lifecycle, security, and recovery](docs/service.md)
- [Agent-assisted Figma Plugin startup](docs/agent-startup.md)
- [Current handoff, verified paths, and known limits](docs/handoff.md)
- [Quality gates by change class](docs/quality-gates.md)
- [Bridge contract](docs/bridge-contract.md)
- [Auto Layout contract](docs/auto-layout-contract.md)
- [Design-system contract](docs/design-system-contract.md)
- [Trace logging and focused bug loop](docs/observability.md)

## Optional collaboration profile

Figma file comments are exposed only when the collaboration profile is enabled. A Figma REST access token is required because comments are not available through the Desktop Plugin API. Reading requires `file_comments:read`; posting and replying require `file_comments:write`.

```bash
MCP_FIG_PROFILES=core,collaboration \
FIGMA_ACCESS_TOKEN=... \
FIGMA_FILE_KEY=... \
node dist/index.js
```

Use `figma_collaboration(action: "comments")` to read comments or filter by `nodeIds`, `resolved`, and `limit`. Use `action: "post"` with an explicit file key, node ID, and node offset for a new anchored comment. Use `action: "reply"` with an explicit file key and root comment ID to reply on the original thread. Comment writes are not idempotent: if a request times out, read comments back before retrying. Figma exposes no endpoint for editing existing comment text; deletion is intentionally not implemented.

## Project status

MCP Fig currently exposes ten core domain tools plus the optional `figma_collaboration` tool. The default Desktop path uses one persistent per-user daemon and owner-only service IPC; fixtures and fake transports do not claim live Figma rendering.

MCP Fig is an independent, unofficial project informed by existing Figma tooling, including [Figma Console MCP](https://github.com/southleft/figma-console-mcp). It is not affiliated with Figma. No license has been selected, so the repository is not licensed for reuse or redistribution.
