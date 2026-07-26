# MCP Fig macOS service

The default Desktop Plugin bridge is a persistent per-user broker. MCP stdio processes connect to its owner-only Unix socket; only the broker owns the localhost Plugin HTTP host, Plugin sessions, file identities, write queues, revisions, and idempotency state.

## Build and lifecycle commands

From a source checkout:

```bash
npm run build
node dist/index.js service install
```

An installed package uses the equivalent `mcp-fig service <command>` entry:

| Command | Behavior |
| --- | --- |
| `install` | Creates or reuses the credential, writes config and plist, rotates oversized logs, and idempotently bootstraps the LaunchAgent. |
| `start` | Bootstraps an unloaded service or kickstarts a loaded but stopped service. |
| `stop` | Idempotently boots out the service and waits up to five seconds for the label to unload. |
| `restart` | Idempotently boots out and bootstraps the service. |
| `status` | Reports secret-free launchd state and daemon health, including PID, version, uptime, sessions, and file identities when available. |
| `logs` | Prints the last 200 stdout/stderr lines and defensively replaces the current credential with `[REDACTED]`. |
| `uninstall` | Boots out the service and removes only its plist, Application Support directory, and log directory. |
| `rotate` | Replaces the long-lived Plugin credential without printing it, removes pending pairing state, and restarts a loaded service. |
| `pair` | Prints a random one-time code and its expiry; validity is capped at two minutes. |

Calling `mcp-fig` with no arguments still starts the existing MCP stdio server. An unknown or missing service subcommand exits with code `2` and prints usage.

## Files and permissions

Production paths:

```text
~/Library/LaunchAgents/com.uforgot.mcp-fig.plist
~/Library/Application Support/mcp-fig/service.json
~/Library/Application Support/mcp-fig/credential.json
~/Library/Application Support/mcp-fig/pairing.json      # only while a code is active
~/Library/Application Support/mcp-fig/service.sock
~/Library/Logs/mcp-fig/service.stdout.log
~/Library/Logs/mcp-fig/service.stderr.log
```

Security modes:

- Application Support and log directories: `0700`, owned by the current user.
- Config, credential, pairing state, plist, and logs: `0600`, regular files owned by the current user.
- Agent IPC socket: `0600`, owned by the current user; its parent path is verified before use.
- Credential/config writes use a same-directory temporary file and atomic replacement. First credential creation uses an atomic hard-link claim so concurrent installs retain one token.
- Reads reject symlinks, non-regular files, another owner, and group/other permission bits.

Log files rotate at lifecycle start/restart when they exceed 1 MB. Three backups are retained as `.1`, `.2`, and `.3`.

## LaunchAgent policy

The generated plist targets the login-user `gui/<uid>` launchd domain and contains:

- `RunAtLoad=true`
- `KeepAlive.SuccessfulExit=false` for crash-only restart
- `ThrottleInterval=10` to avoid an unbounded crash loop
- `ExitTimeOut=15`
- absolute Node executable and built `dist/index.js` paths
- `service run` as the only additional program arguments
- absolute stdout/stderr log paths

The production plist has no credential, token environment variable, or arbitrary environment dictionary. `service run` reads the owner-only config and credential files after launchd starts the process. The token therefore does not appear in plist XML, process arguments, process environment, status output, stdout, or normal logs.

## Pairing boundary

`service pair` generates a high-entropy one-time code and prints only that code plus its expiry. `pairing.json` stores a label-scoped SHA-256 digest, issue time, and expiry—not the plaintext code. The maximum TTL is 120 seconds.

A successful internal exchange atomically renames the pairing record before reading the long-lived credential, so concurrent attempts have one winner. Wrong codes do not consume the record; expired records are removed; used records cannot be replayed. The long-lived credential is returned only to the internal exchange caller and is never printed by the CLI.

The current development Plugin UI does not yet call this exchange or persist the returned credential in Figma `clientStorage`. That UI boundary is intentionally separate. `service uninstall` never traverses or deletes Figma document or `clientStorage` locations.

## Development and verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run smoke:service
npm run smoke:plugin
npm run smoke
npm run smoke:launchd
```

`smoke:launchd` uses a unique temporary label and a short temporary HOME. It validates the plist with `plutil`, bootstraps it in the real login-user launchd domain, correlates launchd PID with daemon health, checks single ownership of the configured Plugin port and `0600` socket, sends `SIGKILL`, waits for a different KeepAlive PID, scans process arguments/plist/stdout/stderr for the generated credential, and performs idempotent bootout. It then removes all temporary files and leaves the production label untouched.

For direct in-process Plugin development, use explicit manual mode and a disposable credential:

```bash
MCP_FIG_DESKTOP_MODE=manual MCP_FIG_PLUGIN_TOKEN='[REDACTED]' npm run canary:plugin
```

Do not copy a real credential into documentation, shell history, plist files, process arguments, CI logs, or issue evidence.
