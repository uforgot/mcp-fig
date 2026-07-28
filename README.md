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

## Install with an AI agent

Give the following prompt to an AI agent that has terminal and file access on the target Mac. The prompt is intentionally self-contained: it defines the supported platform, safety boundary, install path, Figma Plugin handoff, Hermes registration, and verification criteria.

```text
Install MCP Fig from https://github.com/uforgot/mcp-fig.

Target environment:
- macOS login-user account
- Figma Desktop
- Node.js 20 or newer
- Hermes Agent as the MCP client
- source checkout at ~/repos/mcp-fig unless that path already exists elsewhere
- persistent per-user MCP Fig service
- core profile only by default

Scope and safety:
1. Read README.md, docs/service.md, docs/agent-startup.md, and docs/handoff.md before changing the machine.
2. Do not install, configure, or use legacy figma-console-mcp.
3. Do not remove or overwrite an existing MCP Fig checkout, service, credential, or Hermes entry without inspecting it first.
4. Never print, copy, log, screenshot, or type a long-lived service credential, Figma access token, password, or API key.
5. Stop and ask the user at macOS permission, password, keychain, login, security, or payment dialogs.
6. Enter a short-lived MCP Fig one-time pairing code only after explicit user approval for that pairing attempt.
7. Do not modify a Figma document until the user confirms the exact safe target file. Installation verification is read-only by default.
8. If any dispatched mutation has an unknown outcome, do not retry it. Read the exact target back first.

Install or update the source checkout:
- If ~/repos/mcp-fig does not exist, clone https://github.com/uforgot/mcp-fig.git there.
- If it exists, inspect git status first. Do not discard local work. Pull only when the worktree is clean or after preserving user-owned changes.
- Run:
  cd ~/repos/mcp-fig
  npm ci
  npm run build
  npm test

Install and inspect the persistent service:
  node dist/index.js service install
  node dist/index.js service status --json

The service must report service=running before continuing. Do not start a second daemon.

Connect Figma Desktop:
- Ask the user to import ~/repos/mcp-fig/plugin/manifest.json as a Figma development Plugin if it is not already imported.
- In the exact safe Figma file, run Plugins > Development > MCP Fig Live Bridge.
- If pairing is requested, ask for approval, run:
    node dist/index.js service pair
  Then have the user enter only the short-lived one-time code in the Plugin.
- Do not use any manual development token field.
- Verify with:
    node dist/index.js service status --json

Figma connection success requires all of:
- service == "running"
- pluginSessionCount >= 1
- files.length >= 1
- lastHandshakeAt is not null

Register the compiled stdio server in Hermes. Start by inspecting the current registry:
  hermes mcp list

If no `mcp-fig` entry exists, run the following from ~/repos/mcp-fig so $PWD expands to the absolute checkout path. The --args option must remain last:
  hermes mcp add mcp-fig \
    --command node \
    --connect-timeout 60 \
    --env MCP_FIG_DESKTOP_MODE=service MCP_FIG_PROFILES=core \
    --args "$PWD/dist/index.js"

If an `mcp-fig` entry already points to the same absolute dist/index.js path with service mode and the intended profiles, keep it and test it. If it is stale or incorrect, show the difference and ask before replacing it with `hermes mcp remove mcp-fig` followed by the add command. Do not hand-edit unrelated Hermes config.

Verify Hermes registration:
  hermes mcp list
  hermes mcp test mcp-fig

Success requires:
- mcp-fig is enabled
- transport is stdio through node and the absolute dist/index.js path
- the MCP test connects
- exactly the ten core domain tools are discovered

Finally:
- Tell the user to run /reload-mcp in an active Hermes session, or restart the Hermes CLI/gateway through its supported command.
- Do not force-restart the gateway from inside the gateway if it refuses self-restart.
- Report the checkout path, service status summary, Figma file identity, Hermes test result, commands run, and every remaining manual step.
- Do not claim success from a visible Plugin label alone; use service status and hermes mcp test output.

Optional collaboration profile:
- Do not enable it unless the user explicitly requests Figma comment read/post/reply and provides a token with the required file_comments permissions through a secure user-controlled step.
- Never place the token in documentation, chat, command arguments, plist XML, logs, or screenshots.
- After the service securely ingests the token, replace MCP_FIG_PROFILES=core with MCP_FIG_PROFILES=core,collaboration in the Hermes entry and rerun hermes mcp test mcp-fig.
- Collaboration success discovers eleven tools. Existing comment text editing and comment deletion remain unsupported.
```

The AI must return real command output and stop at required user-only Figma or permission steps. A plan without a running service and successful `hermes mcp test mcp-fig` is not a completed installation.

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
