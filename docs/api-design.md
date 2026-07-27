# MCP Fig API design

## Status

Draft architecture for task #1069. This document defines the public MCP surface before implementation. The machine-readable companion is [`api-surface.json`](./api-surface.json).

Source evidence and the complete 113-tool mapping are in [`tool-audit.md`](./tool-audit.md).

## Decision summary

- Expose **12 tools in the default `core` profile**.
- Keep `figma_execute` in the opt-in `advanced` profile, producing the previously discussed **13-tool facade set** when enabled.
- Preserve specialized capabilities through profiles rather than registering one tool for every operation.
- Use one stable tool per domain and a required `action` discriminator.
- Reject unknown fields and invalid action-specific combinations.
- Treat Auto Layout as a first-class typed domain.
- Require explicit target IDs, dry-run support where deterministic, and confirmation for destructive operations.
- Resolve profiles at server startup. Dynamic mid-session profile switching is deferred until clients consistently handle MCP tool-list change notifications.

This avoids both bad extremes: 113 tiny tools and one untyped mega-tool.

## Tool-count budget

| Surface | Tool count | Notes |
|---|---:|---|
| Figma Console MCP Local/NPX | 113 | Verified at runtime against version 1.37.1 |
| MCP Fig `core` | 12 | Default surface |
| `core + advanced` | 13 | Adds raw `figma_execute` |
| Every proposed profile enabled | 17 | Still 85% smaller than 113; specialized actions expand existing facades |

## Default tools

| Tool | Main responsibility | Core actions |
|---|---|---|
| `figma_connection` | Connection, target file, capability discovery | `status`, `list_files`, `target`, `reconnect`, `capabilities` |
| `figma_document` | File-level views and change summaries | `inspect`, `summary`, `changes` |
| `figma_selection` | Current selection and contextual inspection | `get`, `inspect` |
| `figma_node` | Generic node lifecycle, export, and visual properties | `get`, `export`, `create`, `update`, `move`, `resize`, `clone`, `delete` |
| `figma_layout` | Typed Auto Layout operations | `inspect`, `apply`, `sizing`, `batch`, `validate`, `repair` |
| `figma_component` | Components, sets, properties, and slots | `search`, `inspect`, `create_set`, `arrange_set`, property and slot actions |
| `figma_instance` | Instantiate and configure instances | `create`, `update`, `slot_append`, `slot_reset` |
| `figma_tokens` | Variables, collections, modes, and batch changes | `inspect`, `apply`, `collection_create`, `collection_delete` |
| `figma_styles` | Read local styles | `inspect` |
| `figma_screenshot` | One screenshot/export entry point | `capture` |
| `figma_audit` | Structural and visual checks | `verify`, `lint` |
| `figma_annotation` | Figma annotations | `categories`, `get`, `set` |

`figma_execute` is deliberately absent from `core`. It is registered only by `advanced`.

## Profiles

Profiles are selected at process startup, for example:

```bash
MCP_FIG_PROFILES=core,tokens,libraries node dist/index.js
```

`core` is always enabled. Repeating a profile or enabling `core` explicitly is harmless.

| Profile | New tools | Existing tools extended | Capability preserved |
|---|---|---|---|
| `core` | 12 default tools | — | Everyday document, node, layout, component, token, style, screenshot, audit, annotation work |
| `tokens` | None | `figma_tokens` | Import/export and format conversion |
| `libraries` | None | `figma_component`, `figma_tokens` | Published component lookup and library variable import |
| `collaboration` | `figma_collaboration` | — | Comment read/post/delete |
| `history` | `figma_history` | — | Versions, snapshots, diffs, changelog, blame |
| `slides` | `figma_slides` | — | Slides read/write lifecycle |
| `figjam` | `figma_figjam` | — | FigJam content, connectors, creation, arrangement |
| `debug` | None | `figma_connection` | Console logs, watch, clear, plugin reload |
| `advanced` | `figma_execute` | `figma_document`, `figma_audit` | Raw Plugin API execution and specialist analysis |

Profiles gate both tool registration and action enums. A disabled action must not remain in the JSON Schema and fail only at runtime; it should be absent from `tools/list`.

## Common input contract

Every facade uses a required `action` field. Action schemas are discriminated and strict.

```json
{
  "type": "object",
  "required": ["action"],
  "properties": {
    "action": { "type": "string" },
    "fileKey": { "type": "string" },
    "dryRun": { "type": "boolean", "default": false },
    "requestId": { "type": "string" },
    "expectedRevision": { "type": "string" }
  },
  "additionalProperties": false,
  "oneOf": [
    { "$ref": "#/$defs/actionA" },
    { "$ref": "#/$defs/actionB" }
  ]
}
```

Rules:

1. `action` is mandatory and must select exactly one branch.
2. Unknown keys are rejected.
3. Read actions reject mutation-only fields such as `confirm`.
4. Write actions accept `expectedRevision` for optimistic concurrency when the bridge can provide a revision.
5. Batch actions accept at most 100 operations by default.
6. IDs are explicit arrays; implicit “delete current selection” is not allowed.
7. Empty patches and empty destructive target arrays are rejected.

## Shared types

### Node reference

```json
{
  "type": "object",
  "required": ["nodeId"],
  "properties": {
    "fileKey": { "type": "string" },
    "nodeId": { "type": "string", "minLength": 1 }
  },
  "additionalProperties": false
}
```

### Change preview

```json
{
  "target": { "fileKey": "abc", "nodeIds": ["1:2"] },
  "operations": [
    {
      "path": "layout.paddingLeft",
      "before": 16,
      "after": 24,
      "reason": "requested patch"
    }
  ],
  "destructive": false,
  "confirmationToken": null
}
```

The preview is returned by `dryRun: true`. The same normalized operation list is returned after execution so dry-run and applied results can be compared.

## Core action schemas

The full action registry is in `api-surface.json`. The following schemas define the behavior-heavy domains.

### `figma_node`

```json
{
  "action": "update",
  "nodeIds": ["1:2", "1:3"],
  "patch": {
    "name": "Card",
    "text": "Updated label",
    "fontName": { "family": "Inter", "style": "Semi Bold" },
    "fontSize": 18,
    "lineHeight": { "unit": "PIXELS", "value": 24 },
    "letterSpacing": { "unit": "PERCENT", "value": 0 },
    "textAlignHorizontal": "LEFT",
    "textAlignVertical": "CENTER",
    "fills": [{ "type": "SOLID", "color": "#FFFFFF" }],
    "strokes": [{ "type": "SOLID", "color": "#D9D9D9" }]
  },
  "dryRun": true,
  "expectedRevision": "rev-42"
}
```

- `get`: requires `nodeIds`.
- `export`: requires up to 200 `nodeIds`; supports `PNG`, `JPG`, `SVG`, and `PDF`. Raster formats accept `scale` from `0.1` through `4` (default `1`). The Desktop Plugin exports one node per transport response, caps each raw payload at `650 KB`, and the MCP process writes verified owner-only artifacts under `~/.mcp-fig/exports/` subject to a `100 MB` directory quota. Validation finishes before writes begin, and files created by a reported batch-write failure are rolled back.
- `create`: requires `parentId` and `nodeType`.
- `update`: requires `nodeIds` and a non-empty typed `patch`.
  Text nodes accept `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, and horizontal/vertical alignment. `fontSize` has Figma's minimum value of `1`. Figma font weight and style are selected through `fontName.style`; the Plugin loads the target font before mutation and deduplicates mixed-font loads. Uniform typography updates preserve mixed font runs, but replacing mixed-font text requires an explicit `fontName` because assigning `characters` resets range styling.
- `move`: requires `nodeIds`; accepts `parentId`, `index`, or coordinates.
- `resize`: requires `nodeIds` and positive dimensions.
- `clone`: requires `nodeIds`; accepts destination and offset.
- `delete`: requires `nodeIds`, `dryRun` support, and confirmation.

Layout-specific properties are rejected here and routed to `figma_layout`. This keeps generic node patches from bypassing layout validation.

### `figma_layout`

```json
{
  "action": "apply",
  "nodeIds": ["1:2"],
  "layout": {
    "direction": "horizontal",
    "wrap": false,
    "gap": 16,
    "padding": { "top": 24, "right": 24, "bottom": 24, "left": 24 },
    "primaryAlign": "start",
    "counterAlign": "center"
  },
  "dryRun": true
}
```

```json
{
  "action": "sizing",
  "nodeIds": ["1:3"],
  "sizing": {
    "horizontal": "fill",
    "vertical": "hug",
    "minWidth": 120,
    "maxWidth": 480
  }
}
```

Supported normalized values:

- Direction: `horizontal`, `vertical`, `none`
- Sizing: `fixed`, `hug`, `fill`
- Alignment: `start`, `center`, `end`, `space-between`, `baseline`
- Wrap: boolean
- Dimensions and spacing: finite non-negative numbers unless a specific property permits negatives

Action behavior:

| Action | Input | Result |
|---|---|---|
| `inspect` | `nodeIds`, optional depth | Normalized parent/child layout tree and effective sizing |
| `apply` | `nodeIds`, `layout` | Parent Auto Layout patch |
| `sizing` | `nodeIds`, `sizing` | Child or parent sizing patch |
| `batch` | Ordered operations | Dependency-sorted preview/application |
| `validate` | `nodeIds`, optional checks | Stable issue codes with paths and severity |
| `repair` | `nodeIds`, explicit `issueCodes` | Deterministic fixes only; never guesses design intent |

Batch execution order is fixed:

1. Enable/configure parent Auto Layout.
2. Apply parent dimensions and padding.
3. Apply child sizing.
4. Apply min/max and absolute-positioning rules.
5. Validate the resulting hierarchy.

### `figma_tokens`

```json
{
  "action": "apply",
  "operations": [
    {
      "op": "setValue",
      "variableId": "VariableID:1:2",
      "modeId": "1:0",
      "value": "#0057FF"
    }
  ],
  "dryRun": true
}
```

Token operations are typed: `create`, `setValue`, `rename`, `addMode`, `renameMode`, `alias`, and `delete`. Import/export actions appear only with the `tokens` profile. Delete operations and replace imports are destructive.

### `figma_component` and `figma_instance`

Component discovery and definition changes stay separate from instance creation and overrides.

```json
{
  "tool": "figma_instance",
  "arguments": {
    "action": "create",
    "componentKey": "abc123",
    "parentId": "1:2",
    "properties": { "State": "Hover", "Label": "Continue" },
    "dryRun": true
  }
}
```

This preserves the common search → instantiate → configure workflow in two calls without making `figma_component` a catch-all.

## Destructive-action policy

High-risk actions include:

- Node, component-property, variable, collection, comment, and slide deletion
- Token import with `replace` semantics
- Raw `figma_execute`

Required flow:

1. Call with `dryRun: true` where dry-run is supported.
2. Server returns exact targets, normalized changes, warnings, and a short-lived `confirmationToken`.
3. Apply with `confirm: <confirmationToken>` and the same target set.
4. Server rejects stale tokens, changed target sets, or revision mismatches.

`figma_execute` cannot provide a trustworthy general dry-run because arbitrary Plugin API code may have hidden side effects. It therefore requires explicit confirmation, is unavailable in `core`, and returns `dryRunSupported: false` through capability discovery.

## Batch and partial-failure policy

- Validate the full batch before the first write.
- Use rollback when the bridge can snapshot and restore all affected supported properties.
- If true atomicity is unavailable, return `atomic: false` before execution and require explicit opt-in.
- Results contain `applied`, `failed`, and `notAttempted` operation IDs.
- Never report a batch as successful when only part of it applied.

## Result envelope

Successful result:

```json
{
  "ok": true,
  "tool": "figma_layout",
  "action": "apply",
  "target": { "fileKey": "abc", "nodeIds": ["1:2"] },
  "data": {},
  "changes": [],
  "warnings": [],
  "traceId": "req_01"
}
```

Error result:

```json
{
  "ok": false,
  "error": {
    "code": "LAYOUT_FILL_REQUIRES_AUTO_PARENT",
    "message": "Node 1:3 cannot use fill sizing because its parent is not Auto Layout.",
    "retryable": false,
    "details": { "nodeId": "1:3", "parentId": "1:2" }
  },
  "traceId": "req_01"
}
```

Initial error codes:

| Code | Meaning |
|---|---|
| `INVALID_ACTION` | Action is unknown or disabled by profiles |
| `INVALID_ARGUMENT` | Schema or cross-field validation failed |
| `PROFILE_REQUIRED` | Capability exists but its profile is disabled |
| `NOT_CONNECTED` | Desktop Bridge is unavailable |
| `FILE_NOT_TARGETED` | No active file is selected |
| `NODE_NOT_FOUND` | Target node no longer exists |
| `REVISION_CONFLICT` | Document changed after inspection/dry-run |
| `CONFIRMATION_REQUIRED` | Destructive apply lacks a valid token |
| `PARTIAL_APPLY` | Non-atomic operation applied only in part |
| `UNSUPPORTED_BY_BRIDGE` | Current Figma/bridge mode cannot perform the action |
| `INTERNAL_ERROR` | Unexpected server failure; includes trace ID |

Errors should be short and actionable. Stack traces remain in server logs, not tool output.

## Capability discovery

`figma_connection({ "action": "capabilities" })` returns the runtime truth:

```json
{
  "server": "mcp-fig",
  "version": "0.1.0",
  "transport": "stdio",
  "bridge": {
    "connected": true,
    "mode": "desktop-plugin",
    "fileKey": "abc"
  },
  "profiles": {
    "enabled": ["core", "tokens"],
    "available": ["tokens", "libraries", "collaboration", "history", "slides", "figjam", "debug", "advanced"]
  },
  "tools": {
    "count": 12,
    "actions": {
      "figma_layout": ["inspect", "apply", "sizing", "batch", "validate", "repair"]
    }
  },
  "limits": {
    "maxBatchOperations": 100,
    "maxNodeTargets": 200
  },
  "features": {
    "dryRun": true,
    "rollback": "property-scoped",
    "rawExecuteDryRun": false
  }
}
```

Capability discovery reports enabled actions and runtime bridge support. It must not claim that an action works merely because its profile is configured.

## Bridge boundary

The MCP facade owns:

- Tool and action schemas
- Profile gating
- Validation and normalization
- Dry-run previews and confirmation tokens
- Error/result envelopes
- Operation ordering and partial-result reporting

The Figma bridge owns:

- File targeting and connection state
- Plugin API calls
- Node/variable/component reads and writes
- Screenshots/exports
- Best-effort snapshots for rollback

REST should be used for published/read-only data when appropriate. Desktop Plugin API remains the write path. Callers should not need to choose the transport for ordinary actions.

## Workflow validation

All ten audited workflows fit within the default budget or one explicit optional profile:

| Workflow | Required profile | Facade calls |
|---|---|---:|
| Target file | `core` | 1 |
| Inspect selection and context | `core` | 1 |
| Build/repair Auto Layout | `core` | 1–3 |
| Update node geometry/appearance | `core` | 1 |
| Find and instantiate component | `core` | 2 |
| Create component set | `core` | 1–2 |
| Read/update variables | `core` | 1–2 |
| Screenshot and verify | `core` | 1–2 |
| Comments/annotations | `core` + `collaboration` for comments | 1–2 |
| Version investigation | `history` | 1–2 |

No workflow needs more than five calls by design. These are design constraints; task #1075 must measure the implemented server.

## Compatibility coverage

The audited 113 upstream tools remain represented:

- 56 core capabilities collapse into the 12 core facades.
- 56 optional capabilities move to profile-gated actions/tools.
- 1 raw execution capability moves to `advanced`.
- No upstream tool is declared legacy in this phase.
- The complete per-tool destination is retained in `tool-audit.md`.

Capability preservation does not mean identical parameter names or response shapes. MCP Fig is a new API; compatibility is functional, not wire-level.

## Implementation constraints for #1070+

- Build tool schemas from the enabled profile registry at startup.
- Keep action handlers behind domain services so adding a profile does not duplicate implementation.
- Snapshot generated JSON Schemas and the `tools/list` output.
- Assert default `tools/list` count is exactly 12 and `core + advanced` is 13.
- Unit-test every destructive action for dry-run/confirmation behavior.
- Integration-test `figma_connection.capabilities` against disconnected and connected bridge states.
- Keep `figma_execute` physically absent from `tools/list` unless `advanced` is enabled.
