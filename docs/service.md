# MCP Fig macOS service

The normal Desktop bridge is a persistent per-user broker. MCP stdio processes connect through an owner-only Unix socket. Only the broker owns the localhost Plugin host, sessions, file identities, pending requests, per-file write queues, revisions, idempotency, and unknown-outcome policy.

## Build and commands

From a source checkout:

```bash
npm ci
npm run build
node dist/index.js service <command>
```

An installed package uses the equivalent `mcp-fig service <command>` entry.

| Command | Behavior |
| --- | --- |
| `install` | Creates/reuses the credential, writes config/plist, rotates oversized logs, and bootstraps or restarts the LaunchAgent. |
| `start` | Starts an installed service after validating config and credential. |
| `stop` | Idempotently boots the service out of the user launchd domain. Current status then reports `not_installed` even though config/credential files remain; `start` reloads them. |
| `restart` | Rotates oversized logs and restarts the installed service. |
| `status [--json]` | Reports secret-free launchd, daemon, Plugin session, file, and startup state. |
| `logs` | Prints the last 200 stdout/stderr lines with defensive credential redaction. |
| `rotate` | Replaces the long-lived Plugin credential, clears pending pairing state, and restarts a loaded service. Re-pair is required. |
| `pair` | Prints a random one-time code and expiry; validity is at most two minutes. |
| `uninstall` | Boots out launchd and removes only MCP Fig plist, service state, socket, and logs. Figma files and Plugin `clientStorage` are not traversed. |
| `startup ...` | Reads/writes the bounded agent-startup state documented in [`agent-startup.md`](agent-startup.md). |

Examples:

```bash
node dist/index.js service install
node dist/index.js service status --json
node dist/index.js service logs
node dist/index.js service rotate
node dist/index.js service restart
node dist/index.js service uninstall
```

To enable the read-only REST fallback, provide `FIGMA_ACCESS_TOKEN` only to `service install`. Install copies it into the existing owner-only credential file; later MCP processes load it from that file rather than requiring the token in plist XML, process arguments, or the normal runtime environment. `FIGMA_FILE_KEY` may target a cloud file for the MCP process, or callers may pass a file key per supported read. REST requests default to a bounded 5-second timeout; `FIGMA_REST_TIMEOUT_MS` may set 100–60000 ms for unusually large files. Running `service rotate` preserves the REST token while replacing the Plugin credential.

Calling `mcp-fig` without a service subcommand remains the MCP stdio entry. Service mode does not silently start an in-process broker when the daemon is unavailable.

## Files and permissions

```text
~/Library/LaunchAgents/com.uforgot.mcp-fig.plist
~/Library/Application Support/mcp-fig/service.json
~/Library/Application Support/mcp-fig/credential.json
~/Library/Application Support/mcp-fig/pairing.json       # active code digest only
~/Library/Application Support/mcp-fig/pairing-used.json  # replay marker
~/Library/Application Support/mcp-fig/startup-state.json
~/Library/Application Support/mcp-fig/service.sock
~/Library/Logs/mcp-fig/service.stdout.log
~/Library/Logs/mcp-fig/service.stderr.log
```

Security rules:

- Application Support and log directories are owner-only `0700`.
- Config, credential, pairing/startup state, plist, socket, and logs are owner-only `0600` where applicable.
- Reads reject symlinks, foreign owners, non-regular files, and group/other permission bits.
- Config and credential updates use same-directory temporary files and atomic replacement. Concurrent first installs use one atomic credential claim.
- Long-lived Plugin and optional REST credentials are read from the owner-only credential file. They are not placed in plist XML, process arguments, status, stdout, normal logs, or documentation. `FIGMA_ACCESS_TOKEN` is only an install-time ingestion path; it is not copied into launchd.
- `service logs` redacts both current credentials defensively. Log files rotate above 1 MB and retain `.1` through `.3`.

## LaunchAgent lifecycle

The plist runs in the login-user `gui/<uid>` domain with:

- `RunAtLoad=true`;
- crash-only `KeepAlive.SuccessfulExit=false`;
- `ThrottleInterval=10`;
- `ExitTimeOut=15`;
- absolute Node, built `dist/index.js`, and log paths;
- `service run` as the only service arguments.

A crash is restarted by launchd. A clean stop/uninstall is not. The daemon owns one `127.0.0.1:3847` listener and one service socket.

## Pairing and reconnect

1. Install and start the service.
2. Run **Plugins > Development > MCP Fig Live Bridge** in a safe Figma file.
3. If the Plugin asks for pairing, run `node dist/index.js service pair`.
4. Enter only that one-time code in the **One-time pairing code** field.
5. Verify `service status --json` rather than trusting a UI label.

The pairing file stores only a label-scoped SHA-256 digest, issue time, and expiry. Exchange is loopback-only, origin-checked, atomic, and one-winner. After an authenticated handshake, the Plugin stores validated connection config in Figma `clientStorage`; it does not render or log the long-lived credential.

A network failure keeps saved config and retries with bounded backoff. A protocol mismatch requires compatible builds. A `401` after `service rotate` clears stale Plugin config and requires explicit re-pair. Normal operation does not use the manual development token UI.

## Recovery

Start with:

```bash
node dist/index.js service status --json
```

| Status/evidence | Recovery |
| --- | --- |
| `service=not_installed` | Run `service install`. |
| `service=stopped` | Run `service start`, then recheck. |
| `service=unavailable` | Read `service logs`; use `service restart` only for a service fault. Do not repair it through Figma. |
| `PLUGIN_NOT_CONNECTED` | Open a safe Figma file and run the development Plugin. Do not start a second daemon. |
| `401` / rotated credential | Run `service pair` and explicitly re-pair the Plugin. Never recover by copying the long-lived credential. |
| Plugin hot reload/stale session | Wait for the latest ready session; rerun the Plugin once if necessary. Do not reset credentials. |
| Unknown write result | Preserve `UNKNOWN_OUTCOME`, do not retry the write, and use the trace fix loop. |
| Permission/password dialog | Stop automation and ask the user. |

`service uninstall` removes the credential. A later install creates a new one, so any saved Plugin credential must be paired again.

Current status derives installation from the loaded launchd label. Consequently, an intentional `service stop` reports `service=not_installed` rather than `stopped`; `service start` still reloads the retained config. Treat this as a status-model limit, not as proof that service files were deleted.

## Verification

Local and temporary-launchd gates:

```bash
npm run typecheck && npm test && npm run lint && npm run build
npm run smoke:service
npm run smoke:launchd
```

`smoke:launchd` uses a temporary label/HOME, validates the plist, permissions, one-time exchange/replay rejection, single port/socket ownership, crash restart, saved-credential authentication, secret absence, and cleanup. It does not alter the production label.

Production live evidence is recorded in [`handoff.md`](handoff.md). Use [`quality-gates.md`](quality-gates.md) to select a canary. Never put real credentials or pairing codes in shell history, docs, logs, reports, or screenshots.

## Production operations gate

Run this only against the installed production service and disposable nodes in the currently targeted Figma file:

```bash
MCP_FIG_CANARY_REQUIRE_SLEEP_WAKE=1 \
MCP_FIG_CANARY_FILE_KEYS='<file-key-a>,<file-key-b>' \
npm run canary:operations
```

Omit `MCP_FIG_CANARY_FILE_KEYS` for a one-file recovery check. For the full multi-file gate, open the Development Plugin in each intended Figma window first and pass the exact keys printed by `mcp-fig service status --json`. Local Draft keys combine persisted Plugin data `mcp-fig.local-file-id.v1` with a collision-free exact UTF-16 file-name encoding; `local:0:0` is invalid. This stays stable across Plugin restarts and separates Figma's normally renamed file duplicates even though document Plugin data is copied. Renaming a local Draft changes its target key. Figma exposes no stable non-copyable identifier for local files, so two identical local copies manually forced to the same file name cannot be distinguished by a Plugin and are not supported as simultaneous targets. Cloud files continue to use `figma.fileKey`.

The command intentionally pauses twice for real UI/power transitions:

1. At `awaiting_plugin_restart`, close and rerun **MCP Fig Live Bridge** in the same file. Do not re-pair or enter a credential.
2. At `awaiting_sleep_wake`, put macOS to sleep for at least five seconds, wake it, and unlock it. A display-only sleep is not evidence.

The reconnect phase fails unless all of the following hold after service, fresh MCP child, Plugin, and optional sleep-wake recovery:

- the launchd daemon PID changes on service restart while the configured port stays fixed;
- exactly one loopback listener owns the Plugin port and its PID is the daemon PID;
- each ready file key appears once, every requested multi-file key is routable, and a document read succeeds through each exact target;
- Plugin restart replaces the targeted session ID; superseded sessions cannot revive while the newer one is ready;
- the persisted credential file's owner/mode/inode/size/mtime metadata and exact byte digest stay unchanged, so no secret was regenerated or re-entered; the digest is compared internally and never printed;
- a half-open `/next` poll aborts after three seconds and reconnects from the saved credential after service restart or wake;
- sleep-wake requires both a five-second timer gap and a new `Wake from …` power-transition record from `pmset`, followed by a refreshed handshake and document read for the exact target file.

After recovery, `live-multi-agent-canary.mjs` runs representative write/readback/cleanup through the production IPC path. It preserves the no-write-retry contract: a timed-out dispatched write reports `UNKNOWN_OUTCOME`, is attempted once, and is never automatically retried. The command only passes after final node readback and cleanup residue verification.
