# Auto Layout contract

## Scope

`figma_layout` exposes Auto Layout as a typed domain. Task 1073 implements four core actions:

- `inspect`: normalized container, child sizing, bounds, and constraints
- `apply`: container direction, gap, padding, alignment, wrap, and axis sizing
- `sizing`: child `HUG`, `FILL`, or `FIXED` sizing with optional min/max bounds
- `batch`: atomic dependency-ordered application of layout, sizing, and constraints

`validate` and `repair` remain reserved by the API manifest for a later validation task.

## Container input

`layout` accepts:

- `layoutMode`: `HORIZONTAL` or `VERTICAL`
- `gap` or `itemSpacing`: non-negative spacing aliases; sending both is invalid
- `padding`: one non-negative number or `{ top, right, bottom, left }`
- `primaryAxisAlignItems`: `MIN`, `CENTER`, `MAX`, or `SPACE_BETWEEN`
- `counterAxisAlignItems`: `MIN`, `CENTER`, `MAX`, or `BASELINE`
- `layoutWrap`: `NO_WRAP` or `WRAP`
- `primaryAxisSizingMode` and `counterAxisSizingMode`: `FIXED` or `AUTO`

Inspection returns both `gap` and Figma's native `itemSpacing` so clients can use domain wording without losing the underlying property name.

## Child sizing and constraints

`sizing` requires explicit horizontal and vertical values:

- `FIXED`
- `HUG`
- `FILL`

Optional bounds are `minWidth`, `maxWidth`, `minHeight`, and `maxHeight`. A minimum greater than its matching maximum is rejected before commit. `HUG` and `FILL` require an Auto Layout parent.

Batch constraints use Figma's typed horizontal and vertical enums. Constraints are applied after sizing.

## Deterministic batch order

The caller does not need to manually sort nested operations. A batch is flattened and executed in this order:

1. Parent container `apply`, shallowest node first
2. Child `sizing`, shallowest node first
3. Child `constraints`

`appliedOrder` records the actual order as `<operation>:<nodeId>`. Snapshot output is sorted by document depth and node ID for deterministic comparison.

## Preview and atomicity

`apply`, `sizing`, and `batch` accept `dryRun`.

- Every write is evaluated against a cloned file graph.
- `before` and `after` contain normalized layout snapshots.
- A dry run never commits the clone.
- A real batch commits only after every operation succeeds.
- If a later operation fails, earlier operations are rolled back with the clone.

This makes preview output directly comparable with the eventual committed result.

## Adapter capabilities

- In-memory fixture bridge: deterministic reads, previews, and writes
- REST bridge: typed `inspect` only
- Disconnected bridge: structured `NOT_CONNECTED`
- Desktop Plugin bridge: required for live Figma writes
