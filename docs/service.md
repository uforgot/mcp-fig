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
~/Library/Application Support/mcp-fig/pairing-used.json # hashed replay marker until the next code/rotation
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

A `POST /v1/pair/exchange` request requires the current Plugin protocol and code. It is accepted only over the loopback listener with a `null`, `http://localhost`, or `http://127.0.0.1` Origin; missing and remote origins are rejected before the code is inspected. A successful exchange atomically renames the active record to the hashed replay marker before reading the long-lived credential, so concurrent attempts have one winner. Wrong codes do not consume the record; expired records are removed; used codes return `PAIRING_USED` and cannot be replayed.

The Plugin main sandbox provides validated `bridge-config-get`, `bridge-config-set`, and `bridge-config-clear` messages backed by Figma `clientStorage`. The UI exchanges the one-time code, verifies the protocol, completes a credential-authenticated handshake, and only then persists `{version, protocol, port, credential}`. Subsequent Plugin launches reconnect automatically without showing the credential. A successful connection hides pairing inputs and exposes only **Forget** and **Re-pair**. Network failure keeps the saved config and retries with bounded backoff; protocol mismatch asks for an update; a `401` after credential rotation clears the stale config and requires an explicit re-pair.

The **Manual development token** form remains available for explicit env-token canaries. `service uninstall` never traverses or deletes Figma document or `clientStorage` locations.

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

`smoke:launchd` uses a unique temporary label and a short temporary HOME. It validates the plist with `plutil`, bootstraps it in the real login-user launchd domain, correlates launchd PID with daemon health, and checks single ownership of the configured Plugin port and `0600` socket. It performs a real null-origin one-time exchange, rejects immediate replay, sends `SIGKILL`, waits for a different KeepAlive PID, and verifies the saved credential still authenticates after restart. It also scans process arguments/plist/stdout/stderr for the generated credential and performs idempotent bootout. It then removes all temporary files and leaves the production label untouched.

## Live Figma acceptance

Item `1110` closed the deferred live gate in a disposable Figma Desktop file using the production LaunchAgent and owner-only service IPC:

- fresh service installation and one-time pairing reached a ready Plugin session without exposing the long-lived credential;
- service restart, a fresh MCP child process, and an explicit Plugin restart recovered the same file with zero port or token re-entry;
- the Plugin canary read selection/document state, created and renamed a frame, read it back, deleted it, and verified cleanup;
- ten separate Node processes received isolated responses; same-revision writes produced one winner and one `REVISION_CONFLICT`; a duplicate nonce advanced the Plugin revision once; a one-shot post-dispatch timeout returned non-retryable `UNKNOWN_OUTCOME` and was not retried;
- one process owned `127.0.0.1:3847`, and all matching canary artifacts were removed from the file.

The production canaries in `scripts/live-*.mjs` are service IPC clients. They do not bind a second Plugin HTTP host or require `MCP_FIG_PLUGIN_TOKEN`. `canary:plugin` waits briefly after its build because Figma development hot reload can replace the Plugin session just after the bundle changes.

Known limits:

- launchd keeps the broker alive but cannot make Figma automatically run a development Plugin; the Plugin must be started in an already-open safe file, manually or through the bounded agent startup adapter;
- Figma hot reload may leave older same-file session records visible until their TTL expires; requests target the latest ready session;
- this acceptance used a disposable local Draft (`local:0:0`), so it does not claim cloud-file lifecycle behavior or unattended startup while Figma is closed.

For direct in-process Plugin development, use explicit manual mode and a disposable credential:

```bash
MCP_FIG_DESKTOP_MODE=manual MCP_FIG_PLUGIN_TOKEN='[REDACTED]' npm run canary:plugin
```

Do not copy a real credential into documentation, shell history, plist files, process arguments, CI logs, or issue evidence.
