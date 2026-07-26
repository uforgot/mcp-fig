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

## Project status

MCP Fig currently exposes eight domain tools: connection, document, selection, node, layout, component, instance, and tokens. The default Desktop path uses one persistent per-user daemon and owner-only service IPC; fixtures and fake transports do not claim live Figma rendering.

MCP Fig is an independent, unofficial project informed by existing Figma tooling, including [Figma Console MCP](https://github.com/southleft/figma-console-mcp). It is not affiliated with Figma. No license has been selected, so the repository is not licensed for reuse or redistribution.
