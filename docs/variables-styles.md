# Variables and local styles

This document is the item `1156` contract for design-system variables and local Figma styles.

## Facades

- `figma_tokens` keeps typed variable and binding operations in one facade.
- `figma_styles` manages local PAINT, TEXT, EFFECT, and GRID styles.
- Local writes and published-library imports are separate actions. A fixture result is never evidence that a published library is available in a live Figma account.

## Variables

### Actions

| Action | Scope |
|---|---|
| `inspect` | canonical local collections, modes, variables, and per-mode values |
| `collection_create` / `collection_update` / `collection_delete` | local collection CRUD; delete requires dry-run confirmation |
| `variable_create` / `variable_update` / `variable_delete` | local variable CRUD; delete requires dry-run confirmation |
| `apply` | bounded mode/value/alias/bind operations after whole-batch prevalidation |
| `library_import` | known published variable key only; not local CRUD |

`apply` operations are `mode_add`, `mode_rename`, `mode_remove`, `set_value`, `alias`, `bind`, and `unbind`.

### Typed values

- `BOOLEAN` → boolean
- `COLOR` → RGBA `{r,g,b,a}`, each channel in `0..1`
- `FLOAT` → finite number
- `STRING` → string
- aliases → `{type:"VARIABLE_ALIAS",id:<variable id>}` and the target must have the same `resolvedType`

Collection modes are always serialized as `{id,name}` even though the native Plugin API calls the ID field `modeId`.

### Validation and mutation semantics

- Every `apply` batch is validated against an in-memory plan before the first Figma setter call.
- Unknown collection, variable, mode, node, or binding field fails with `INVALID_ARGUMENT` or `NODE_NOT_FOUND` before mutation.
- Alias target types must match.
- Direct and transitive alias cycles are rejected per mode.
- The default mode and the last remaining mode cannot be removed.
- Node binding field types are checked (`fills`/`strokes` → COLOR, `opacity`/`width`/`height`/`itemSpacing` → FLOAT, `visible` → BOOLEAN, `characters` → STRING). Other fields are rejected before mutation.
- `fills` and `strokes` bind the `color` field of the first SOLID paint through native `setBoundVariableForPaint`; unbind removes that paint-level binding. Other supported fields use node-level `setBoundVariable`.
- Plugin COLOR channels and style numeric fields are serialized to six decimal places so Figma float32 storage has deterministic exact readback.
- The deterministic fixture commits the complete planned batch at once. The Plugin prevalidates the complete batch; native failures after dispatch are not reported as a fabricated rollback.

## Local styles

### Actions

| Action | Scope |
|---|---|
| `inspect` | local PAINT/TEXT/EFFECT/GRID inventory, optionally filtered by kind or IDs |
| `create` | create one typed local style |
| `update` | full typed replacement of one local style; kind cannot change |
| `delete` | delete one local style after dry-run confirmation |
| `library_import` | import one published style by known key under the `libraries` profile |

`library_import` is not a local style write. Published/remote styles are returned with `source:"library"` and cannot be updated or deleted by local CRUD.

### Typed payloads

- PAINT: SOLID, GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR, GRADIENT_DIAMOND.
- TEXT: `fontName`, positive `fontSize`, typed `lineHeight`, typed `letterSpacing`, optional paragraph spacing/indent, case, and decoration. The Plugin loads the font before assigning text-style properties.
- EFFECT: DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR.
- GRID: GRID, COLUMNS, and ROWS with typed alignment/count/gutter/offset data.

### Failure semantics

- A style is tracked immediately after native creation. If property application fails, the new style is removed.
- Update snapshots the existing style and attempts rollback on failure. If both update and rollback fail, the result is `UNKNOWN_OUTCOME`.
- Published-key import definite rejection is `LIBRARY_IMPORT_FAILED`. The four-second uncancellable timeout is `UNKNOWN_OUTCOME` with `reason:TIMEOUT_PENDING` because the Figma promise may still complete.
- Library inventory search is not claimed. Imports are known-key only.

## Acceptance gate

The live canary must create a disposable Light/Dark collection, COLOR variables with exact RGBA values, a same-type alias, and a node binding; then read all values, alias, and binding back exactly. It must also create and inspect local PAINT, TEXT, EFFECT, and GRID styles. Invalid alias cycle and type mismatch must leave the prior value unchanged. All disposable nodes, collections, variables, and styles must be removed and the final exact-name inventory must be empty.

### Verified live evidence

`scripts/live-variables-styles-canary.mjs` passed against the real Figma file `260421_HDC랩스_HDC랩스 웹사이트 리뉴얼` through persistent-service IPC:

- collection `VariableCollectionId:3656:31240`
- Light `3656:12` → `{r:0.12,g:0.24,b:0.48,a:1}`
- Dark `3656:13` → `{r:0.72,g:0.82,b:0.96,a:1}`
- base variable `VariableID:3656:31241`
- alias/binding variable `VariableID:3656:31242`
- alias cycle and type mismatch both returned `INVALID_ARGUMENT` without mutation
- local PAINT, TEXT, EFFECT, and GRID style create/inspect/update paths passed
- final canary output returned `cleanup:true`; no prefixed collection, style, or node remained
