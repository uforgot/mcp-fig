# Current handoff

## Current decision

MCP Fig is replacement-ready for the owner's routine Figma Design workflow on macOS. The legacy Figma Console MCP is not required for the verified internal workflow. This is an internal production decision, not a public-release claim: the project remains version `0.0.0`, private, unlicensed, and without external installation support.

The runtime exposes ten typed core domain tools plus the optional `figma_collaboration` tool. The normal write path is:

`MCP stdio → owner-only service IPC → persistent per-user daemon → Figma Desktop Plugin → Figma API`

Cloud comments use a separate typed boundary:

`figma_collaboration → Figma REST API`

Local unsaved canvas operations must use the exact Desktop Plugin file identity; cloud comments must use the cloud file key. Do not substitute one identity or transport for the other.

## Verified replacement gates

The P0 replacement gate passed against the connected `Untitled` Figma Desktop file using MCP Fig typed actions only:

- exact file targeting, selection, document inspection, and reconnect;
- bounded node query and node create/update/move/resize/clone/delete;
- whole-node and text-range typography;
- local and HTTPS image import, image fills, and PNG/JPG/SVG/PDF export;
- Auto Layout apply, sizing, validation, repair contracts, and exact readback;
- components, variants, instances, slots, overrides, swaps, and resets;
- variables, modes, aliases, bindings, and local styles;
- known-key enabled-library import and idempotent reuse;
- Desktop screenshots, node exports, model-state audits, and artifact cleanup;
- multi-file routing, service/Plugin restart recovery, write serialization, revision conflict, idempotency, and unknown-outcome safety;
- zero Figma Console MCP, browser mutation, or raw-execute fallback.

The automated suite currently passes 28 test files / 197 tests. See [`console-mcp-replacement.md`](console-mcp-replacement.md) for the capability matrix and exact evidence.

## Reviewed-page hard dogfood

A production-style design task was completed in the same `Untitled` file without Console MCP fallback.

- Source wireframe `62:8502` remained unchanged.
- Desktop design `66:2755` remained `1920 × 5853` and was organized as a vertical root Auto Layout with seven fixed section wrappers.
- The existing library GNB instance was retained.
- A desktop footer master and four fire-safety stage-card masters were created and used through linked instances.
- The four-card row, card masters, footer master, and component-library frame received nested Auto Layout.
- Review comments were read through the collaboration profile; completion replies were posted once per original thread and read back.
- Full-page exports, Desktop screenshots, component/instance readback, accessibility/layout/lint audits, and FFmpeg pixel-difference checks were used as distinct evidence.
- Mobile design `85:2460` was created as a separate `390 × 5400` vertical Auto Layout frame with a mobile GNB, two-level tabs, portrait overview, one-column linked stage-card instances, stacked product content, and mobile footer.
- Final visual QA found no missing sections, duplicated content, clipping blocker, card overflow, product text collision, or footer loss.

This dogfood is stronger evidence for the internal replacement decision than disposable CRUD fixtures alone because it exercised long-lived document state, reviewed content, reusable components, absolute overlays inside section flow, full-page rendering, and responsive adaptation.

## Runtime and ownership

The installed service uses a per-user LaunchAgent, an owner-only Unix socket, one-time pairing, Plugin `clientStorage` reconnect, per-file write serialization, revision checks, idempotency, non-retried unknown outcomes, and correlated redacted events. Agent-assisted Figma startup is bounded best effort; it is not part of daemon ownership.

Compatibility entries remain at `plugin/main.js`, `src/bridge/desktop-plugin.ts`, and `src/bridge/in-memory.ts`. `plugin/main.js` is generated and checked for deterministic drift. Do not move domain behavior back into compatibility or generated files.

The production canaries in `scripts/live-plugin-canary.mjs`, `scripts/live-reconnect-canary.mjs`, and `scripts/live-multi-agent-canary.mjs` use service IPC. They do not create a second Plugin host or require repeated manual token entry.

## Known limits

- Figma must be open with the development Plugin running in a safe file. launchd cannot force a development Plugin to remain active.
- Enabled component-library inventory is unavailable through the Plugin API. Known-key import and already-imported component reuse are supported.
- Existing comment text cannot be edited through Figma's API. Comment deletion and Plugin annotations are not implemented.
- Raw arbitrary execution is intentionally absent.
- FigJam, Figma Slides, cloud canvas mutation relay, MCP Apps, version history, and blame are outside the replacement scope.
- Service status, structured events, traces, and bug reports replace routine diagnostics, but a live Figma console stream is not implemented.
- Full-document serialization can exceed bounded request budgets; prefer targeted node reads and exact root scopes.
- A timed-out or serialization-failed mutation can have an unknown outcome. Never retry blindly; perform exact readback first.
- External-user installation, release packaging, license selection, upgrade policy, and long-duration public support are not complete.

## Next priorities

1. Keep observed dogfood failures in the `trace → reproduce → failing test → minimal fix → focused test → live readback` loop.
2. Split manual mega files only when their ownership causes real review or maintenance failures; do not hand-edit generated `plugin/main.js` or schema snapshots.
3. Before a public release, choose a license and version, define package/install/upgrade support, run a clean external-environment setup, and publish release notes.
4. Preserve the replacement rule: typed MCP Fig actions first, exact readback after uncertain writes, and no silent Console/browser fallback.

## Start here

- Replacement status and evidence: [`console-mcp-replacement.md`](console-mcp-replacement.md)
- Architecture and change ownership: [`maintenance.md`](maintenance.md)
- Service operations and recovery: [`service.md`](service.md)
- Agent-assisted Plugin startup: [`agent-startup.md`](agent-startup.md)
- Minimum verification by change class: [`quality-gates.md`](quality-gates.md)
- Trace and bug report loop: [`observability.md`](observability.md)
