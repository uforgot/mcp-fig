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

Give the following prompt to an AI agent with terminal and file access on the target Mac. It installs one shared MCP Fig service and then selects exactly one client adapter for Hermes, OpenClaw, Codex CLI, Claude Code, OpenCode, or Grok Build.

```text
Install MCP Fig from https://github.com/uforgot/mcp-fig.

Target environment:
- macOS login-user account
- Figma Desktop
- Node.js 20 or newer
- one requested MCP client: Hermes, OpenClaw, Codex CLI, Claude Code, OpenCode, or Grok Build
- source checkout at ~/repos/mcp-fig unless it already exists elsewhere
- persistent per-user MCP Fig service
- core profile only by default

Scope and safety:
1. Read README.md, docs/service.md, docs/agent-startup.md, and docs/handoff.md before changing the machine.
2. Detect the requested client and its installed version. Use exactly one matching adapter below; do not guess unsupported flags.
3. Do not remove legacy figma-console-mcp until MCP Fig passes the new client's registration check and a live Figma canary. Ask before removal.
4. Do not overwrite an existing checkout, service, credential, client config, or unrelated config key. Inspect first and preserve user-owned changes.
5. Never print, copy, log, screenshot, or type a long-lived service credential, Figma access token, password, or API key.
6. Stop and ask the user at macOS permission, password, keychain, login, security, or payment dialogs.
7. Enter a short-lived MCP Fig one-time pairing code only after explicit user approval for that attempt.
8. Do not mutate a Figma document until the user confirms the exact safe target file. Installation verification is read-only by default.
9. If a dispatched mutation has an unknown outcome, do not retry it. Read the exact target back first.

Install or update the source checkout:
- If ~/repos/mcp-fig does not exist, clone https://github.com/uforgot/mcp-fig.git there.
- If it exists, inspect git status first. Do not discard local work. Pull only when clean or after preserving user-owned changes.
- Resolve the checkout to an absolute path and call it <ABS_REPO>.
- Run:
  cd <ABS_REPO>
  npm ci
  npm run build
  npm test

Install and inspect the persistent service:
  node dist/index.js service install
  node dist/index.js service status --json

The service must report service=running before continuing. Do not start a second daemon.

Connect Figma Desktop:
- Ask the user to import <ABS_REPO>/plugin/manifest.json as a Figma development Plugin if it is not already imported.
- In the exact safe Figma file, run Plugins > Development > MCP Fig Live Bridge.
- If pairing is requested, ask for approval, run `node dist/index.js service pair`, and have the user enter only the short-lived one-time code.
- Do not use a manual development token field.
- Verify with `node dist/index.js service status --json`.

Figma connection success requires all of:
- service == "running"
- pluginSessionCount >= 1
- files.length >= 1
- lastHandshakeAt is not null

Register the stdio server with exactly one matching client adapter. In every command, replace <ABS_REPO> with the real absolute path. Inspect an existing `mcp-fig` entry first; keep it if it already matches. If it is stale, show the difference and ask before replacing it.

Hermes:
  hermes mcp list
  hermes mcp add mcp-fig \
    --command node \
    --connect-timeout 60 \
    --env MCP_FIG_DESKTOP_MODE=service MCP_FIG_PROFILES=core \
    --args <ABS_REPO>/dist/index.js
  hermes mcp test mcp-fig
  # Run /reload-mcp in an active session, or restart the CLI/gateway through its supported command.

OpenClaw builds that expose native `openclaw mcp` management (verified with 2026.7.2-beta.3):
  openclaw mcp list
  openclaw mcp add mcp-fig \
    --command node \
    --arg <ABS_REPO>/dist/index.js \
    --cwd <ABS_REPO> \
    --env MCP_FIG_DESKTOP_MODE=service \
    --env MCP_FIG_PROFILES=core \
    --connect-timeout 60 \
    --timeout 30
  openclaw mcp probe mcp-fig
  openclaw mcp doctor --probe mcp-fig
  openclaw mcp reload
  # Do not use `openclaw mcp list --json` on versions that expose stdio env values without redaction.

Codex CLI:
  codex mcp list
  codex mcp add mcp-fig \
    --env MCP_FIG_DESKTOP_MODE=service \
    --env MCP_FIG_PROFILES=core \
    -- node <ABS_REPO>/dist/index.js
  codex mcp get mcp-fig
  # Restart Codex so the new tools are loaded, then run the read-only connection canary.

Claude Code:
  claude mcp list
  claude mcp add --scope user \
    -e MCP_FIG_DESKTOP_MODE=service \
    -e MCP_FIG_PROFILES=core \
    mcp-fig -- node <ABS_REPO>/dist/index.js
  claude mcp get mcp-fig
  # Restart Claude Code if the current session does not load the new tools.

OpenCode:
- If installed, `opencode mcp add` is an official guided flow. Configure a local stdio server named mcp-fig with command `node <ABS_REPO>/dist/index.js` and the two core environment values.
- For deterministic setup, merge only the `mcp.mcp-fig` object below into the existing global config at ~/.config/opencode/opencode.json. Do not overwrite other keys:
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "mcp-fig": {
        "type": "local",
        "command": ["node", "<ABS_REPO>/dist/index.js"],
        "enabled": true,
        "environment": {
          "MCP_FIG_DESKTOP_MODE": "service",
          "MCP_FIG_PROFILES": "core"
        },
        "timeout": 30000
      }
    }
  }
- Run `opencode mcp list`, restart OpenCode, and run the read-only connection canary.

Grok Build:
  grok mcp list
  grok mcp add --scope user \
    -e MCP_FIG_DESKTOP_MODE=service \
    -e MCP_FIG_PROFILES=core \
    mcp-fig -- node <ABS_REPO>/dist/index.js
  grok mcp doctor
  # Start a fresh Grok Build session or open /mcps, then run the read-only connection canary.

Client verification succeeds only when:
- mcp-fig is enabled and points to node plus the absolute dist/index.js path;
- the client connects without spawning a second MCP Fig daemon;
- the ten core tools are available;
- `figma_connection` status/targeting and a document read work against the exact safe Figma file;
- no Console MCP, browser mutation, or raw-execute fallback was used.

Optional collaboration profile:
- Enable only when the user explicitly requests Figma comment read/post/reply and securely supplies a token with the required file_comments permissions.
- Never put the token in documentation, chat, command arguments, client config, plist XML, logs, or screenshots.
- Let the MCP Fig service ingest the token through the documented secure install path, then change MCP_FIG_PROFILES from core to core,collaboration in the selected client adapter.
- Rerun that client's registration/connectivity check. Collaboration success exposes eleven tools.
- Existing comment text editing and comment deletion remain unsupported.

Finally report the checkout path, client/version, commands run, service status summary, exact Figma file identity, discovered tool count, live read-only canary result, and every remaining manual step. A plan without a running service, a ready Plugin session, and a successful client connection is not a completed installation.
```

The client commands above were verified against the local Hermes, OpenClaw, Codex CLI, Claude Code, and Grok Build help surfaces available on 2026-07-28. OpenCode syntax and config shape follow its official MCP and configuration documentation; OpenCode was not installed on the verification Mac.

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
