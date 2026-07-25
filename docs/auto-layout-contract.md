# Auto Layout contract

## Scope

`figma_layout` exposes Auto Layout as a typed domain with six core actions:

- `inspect`: normalized container, child sizing, bounds, and constraints
- `apply`: container direction, gap, padding, alignment, wrap, and axis sizing
- `sizing`: child `HUG`, `FILL`, or `FIXED` sizing with optional min/max bounds
- `batch`: atomic dependency-ordered application of layout, sizing, and constraints
- `validate`: deterministic overflow, sizing-context, and min/max diagnostics
- `repair`: guarded fixes for issues that do not require design intent

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

## Validation and repair

`validate` traverses every requested node and its descendants. It returns stable issue codes, node IDs, human-readable messages, repairability, and measured details.

| Issue code | Meaning | Automatic repair |
|---|---|---|
| `AUTO_LAYOUT_OVERFLOW_HORIZONTAL` | Fixed horizontal bounds are smaller than required flow content | No |
| `AUTO_LAYOUT_OVERFLOW_VERTICAL` | Fixed vertical bounds are smaller than required flow content | No |
| `FILL_IN_HUG_PARENT_HORIZONTAL` | Horizontal `FILL` creates a circular dependency with a hugging parent | `FIXED` |
| `FILL_IN_HUG_PARENT_VERTICAL` | Vertical `FILL` creates a circular dependency with a hugging parent | `FIXED` |
| `HUG_WITHOUT_AUTO_LAYOUT_PARENT` | `HUG` is set without an Auto Layout parent | `FIXED` |
| `FILL_WITHOUT_AUTO_LAYOUT_PARENT` | `FILL` is set without an Auto Layout parent | `FIXED` |
| `MIN_MAX_CONFLICT_WIDTH` | `minWidth` exceeds `maxWidth` | No |
| `MIN_MAX_CONFLICT_HEIGHT` | `minHeight` exceeds `maxHeight` | No |

Overflow uses flow children, padding, and gap. Hidden children and `layoutPositioning: ABSOLUTE` children are excluded. Wrapped containers skip geometric overflow diagnosis because row packing cannot be inferred safely from the stored fixture geometry.

Repairable HUG/FILL issues become `FIXED`, preserving the node's measured width and height. Every repair reports its issue code, reason, and exact property transition. Overflow and min/max conflicts are diagnostics only because choosing a new dimension or bound requires design intent.

A repair request is all-or-nothing. If any requested issue code is not safely repairable, the whole request fails before mutation. Successful repairs run against a clone and include `beforeValidation`, `repairs`, and `afterValidation`; revalidation must remove the selected issues before the clone is committed.

## Preview and atomicity

`apply`, `sizing`, `batch`, and `repair` accept `dryRun`.

- Every write is evaluated against a cloned file graph.
- `before` and `after` contain normalized layout snapshots.
- A dry run never commits the clone.
- A real batch commits only after every operation succeeds.
- If a later operation fails, earlier operations are rolled back with the clone.

This makes preview output directly comparable with the eventual committed result.

## Adapter capabilities

- In-memory fixture bridge: deterministic reads, previews, and writes
- REST bridge: typed `inspect` and `validate`; no writes
- Disconnected bridge: structured `NOT_CONNECTED`
- Desktop Plugin bridge: required for live Figma writes
