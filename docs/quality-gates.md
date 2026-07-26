# Quality gates

Use the smallest gate that proves the changed boundary, then run the full static/test/build gate before commit. A fixture pass is never live Figma evidence.

## Full gate

```bash
npm run typecheck && npm test && npm run lint && npm run build
npm run smoke
npm run smoke:plugin
```

`npm test` includes generated Plugin drift checking. `npm run smoke` exercises the built stdio server. `npm run smoke:plugin` uses a deterministic fake Plugin transport and checks process cleanup.

## Minimum gate by change class

| Change class | Minimum focused gate | Additional required evidence |
| --- | --- | --- |
| Pure refactor | Relevant targeted Vitest files; `git diff --check`; no unintended `tests/snapshots/*` diff | Full gate. Plugin source refactors also run `npm run check:plugin-bundle`; fixture splits run core/layout/layout-validation/design-system/quality-gate tests. |
| Service protocol, socket, daemon, lifecycle, credential, or launchd | `npx vitest run tests/service-daemon.test.ts tests/service-lifecycle.test.ts tests/desktop-plugin-bridge.test.ts tests/config.test.ts` | `npm run smoke:service` and `npm run smoke:launchd`; protocol mismatch, malformed request, permissions, secret scan, shutdown, and unknown-write classification must remain covered. |
| Plugin-primary REST fallback routing | `npx vitest run tests/hybrid-bridge.test.ts tests/rest-bridge.test.ts tests/service-daemon.test.ts tests/config.test.ts` | Prove Plugin success remains primary; only pre-dispatch `NOT_CONNECTED` reads fall back; writes, selection, domain errors, dispatched timeout, and `UNKNOWN_OUTCOME` do not. Verify REST 401/429/timeout, source/revision/warning metadata, owner-only token storage, and secret absence. A fake protocol session is not live Figma GUI evidence. |
| Mutation semantics | Domain integration tests plus `tests/desktop-plugin-bridge.test.ts` and relevant Plugin tests | `npm run smoke:plugin`; for production behavior, `npm run canary:plugin` on a disposable Figma file with create/update/readback/delete and `cleanup: true`. Dry-run, revision, confirmation, idempotency, rollback, and unknown outcomes must match the touched action. |
| Reconnect/session routing | `npx vitest run tests/desktop-plugin-bridge.test.ts tests/service-daemon.test.ts tests/service-lifecycle.test.ts tests/plugin-ui.test.ts` | `npm run canary:reconnect`; verify service, MCP process, and Plugin restart paths recover without port/token re-entry and target the latest ready session. |
| Multi-process/write coordination | `npx vitest run tests/desktop-plugin-bridge.test.ts tests/service-daemon.test.ts tests/trace-correlation.test.ts` | `npm run canary:multi-agent`; require ten isolated clients, conflict winner/loser 1/1, duplicate mutation count 1, readback, cleanup, and no automatic retry of `UNKNOWN_OUTCOME`. |
| Vision-assisted startup/status | `npx vitest run tests/startup-state.test.ts tests/agent-status.test.ts tests/agent-startup-cli.test.ts tests/service-lifecycle.test.ts` | `hermes computer-use doctor`; actual background Figma capture/menu action when available; foreground only after a returned escalation signal; final `service status --json` with running service, non-zero Plugin session/files, handshake, and `startupState=verified`. Never click permissions or type credentials. |

## Compact facade and snapshots

`tests/quality-gates.test.ts` runs through the real MCP client/server transport using `tests/fixtures/workflow-benchmarks.json`. The committed fixture baseline is:

| Gate | Required | Current fixture baseline |
| --- | ---: | ---: |
| Core tools | 15 or fewer | 8 |
| Calls per workflow | 5 or fewer | 5 maximum |
| Auto Layout without raw execution | at least 90% | 10/10 |
| Representative fixture workflows | all | 12/12 |

`tests/snapshots/core-tool-schemas.json` freezes MCP-visible tool schemas. `tests/snapshots/auto-layout-structural-visual.json` freezes normalized layout structure. The latter is not a rendered pixel screenshot.

Update snapshots only for an intentional reviewed contract change:

```bash
npm run snapshots:update
```

Review every generated diff and rerun the full gate.

## Live evidence rules

- Use a disposable safe file and record the exact canary output.
- Require cleanup confirmation; do not leave canary nodes.
- Do not report fixture/fake transport as live Plugin success.
- Do not report a UI label as broker success; verify `service status --json`.
- Never paste credentials, pairing codes, Authorization headers, socket payloads, or full documents into evidence.
- No guessed benchmark. Report only observed counts/timings and label the environment.
