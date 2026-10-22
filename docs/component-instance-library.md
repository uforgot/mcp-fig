# Component, instance, slot, and library contract

This contract extends the existing `figma_component` and `figma_instance` facades. It does not add top-level MCP tools or imply that the Figma Plugin API can enumerate a full component-library catalog.

## Local components and component sets

`figma_component.search` and `inspect` read both `COMPONENT` and `COMPONENT_SET` nodes after `loadAllPagesAsync()`, including remote main components resolved from document instances and their available parent sets. Records expose `kind`, local/library source, node ID, key, description, and canonical property definitions.

`create_set` accepts 1–8 axes, 1–20 unique non-empty values per axis, and at most 100 Cartesian variants. The Plugin creates all variants, calls `combineAsVariants`, and removes the set or every created variant if a later step fails. Variant children cannot read `componentPropertyDefinitions` directly in Figma; readback falls back to their parent component set definitions.

Property definitions support `BOOLEAN`, `TEXT`, `INSTANCE_SWAP`, `VARIANT`, and `SLOT` readback. `VARIANT` definitions are derived by Figma from variant names and cannot be added manually. `SLOT` is also rejected by generic `property_add`; use `slot_create` so Figma creates a physical `SlotNode`. `options` maps to `variantOptions` for variants and component-key `preferredValues` for instance-swap definitions. Property type changes are rejected because Figma does not support them.

Figma may canonicalize a UI property name such as `Label` to `Label#51:30`. Readback preserves that actual key. Instance writes accept either the exact key or one unambiguous display name before `#`; ambiguous or missing names fail before mutation with `INVALID_ARGUMENT` and available key/name details.

## Instances

`figma_instance` supports:

- `inspect`: bounded read of 1–200 instance IDs.
- `create`: exactly one local component ID or component key, parent, optional position, and property values.
- `swap`: 1–200 instances, exactly one target component ID/key, with override preservation enabled by default.
- `update`: property values with exact/display-name key resolution.
- `reset`: removes visual overrides and restores every current component property from the main component or parent component-set defaults.
- `slot_append` and `slot_reset`: operate only on an actual descendant `SLOT` node.

Create resolves local component keys before attempting a published library import. Update, swap, and reset prevalidate every target before mutation. Property-only update snapshots values and attempts rollback. Figma does not expose a complete snapshot/restore API for visual, nested-instance, and other overrides, so a mid-apply swap/reset failure returns `UNKNOWN_OUTCOME` with `completedCount`/`attemptedIndex`/`total` instead of performing a destructive fake rollback. A failed `slot_reset` is also `UNKNOWN_OUTCOME` because removed slot children cannot be reconstructed safely.

## Slots

`figma_component.slot_create` is available only for `COMPONENT` targets and calls `ComponentNode.createSlot()`. It creates a physical child `SlotNode` plus Figma's corresponding canonical `SLOT` property; `COMPONENT_SET` targets return `UNSUPPORTED_BY_BRIDGE`. Renaming the node can change the canonical property key, so the implementation reads the post-rename definitions before applying preferred component keys, description, and bounded slot settings. `minChildren` must not exceed `maxChildren`; Figma canonicalizes `minChildren: 0` to `null`.

Instances created from that component materialize the descendant `SlotNode`. Runtime append/reset matches the physical node by its name or `componentPropertyReferences.slot` exact/display name. Missing runtime content returns `SLOT_NOT_FOUND`; scalar instance-property update/reset excludes SLOT values and directs callers to `slot_append`/`slot_reset`.

## Libraries and explicit API limits

Core exposes `library_search` and `library_inspect` inside `figma_component`; the optional `libraries` profile adds `library_import`.

Figma Plugin API has no full component-library inventory/search API. `library_search` instead returns library components referenced in the current file, deduplicated by node ID, and `library_inspect` resolves a readable referenced key. Neither imports anything. Unknown/unreferenced keys return `NODE_NOT_FOUND`, not a pretend cloud inventory. Results include `libraryCoverage` with `scope: referenced_components_only`, `fullCatalog: false`, the scan offset, total/scanned/unavailable instance counts, and truncation. A scan resolves at most 500 instances in batches of eight. Follow `nextReferenceOffset` using `referenceOffset` on search/inspect; inspecting a used instance's `mainComponentId` directly avoids the inventory scan. Full unused-library browsing still requires opening the source library file. Reads are allowed in Dev Mode; imports are not.

`library_import` accepts a known published key and explicit `COMPONENT` or `COMPONENT_SET` kind. It uses `importComponentByKeyAsync` or `importComponentSetByKeyAsync` and returns the imported record/node. A definite rejection returns `LIBRARY_IMPORT_FAILED` with `reason: PLAN_ACCESS_OR_KEY`. The Figma import promise is not cancellable: when the four-second observation bound expires, the operation may still finish later, so the result is `UNKNOWN_OUTCOME` with `reason: TIMEOUT_PENDING`, not a false definite failure. The API does not reveal which of key, plan, access, or enabled-library state caused a generic rejection.

## Fixture versus Plugin live behavior

The in-memory fixture limits library search to component keys referenced by document instances (plus remote nodes already present), while retaining a fixture key inventory for explicit imports. It models `slot_create` as a physical `SLOT` child cloned into local instances. These tests cannot prove account plan, library enablement, network access, Figma-generated property key suffixes/rename timing, actual SlotNode materialization, or API latency.

The historical 2026-07-27 persistent Desktop Plugin canary on `local:0:0` (before referenced-library reads were added) confirmed:

- a disposable `COMPONENT_SET` with 2 axes and 4 variants;
- local set search/inspect with `kind: COMPONENT_SET`;
- exact `State` (`Default`, `Hover`) and `Size` (`S`, `L`) variant options;
- native TEXT definitions plus a separate physical SlotNode canary: `createSlot()` returned `SLOT 54:168`, post-rename canonical key `Content#54:53`, instance append child count `1`, and reset child count `0`;
- instance create with display-name property mapping, property override, override-preserving variant swap, and reset to `Label=Continue`, `State=Default`, `Size=S`;
- `LIBRARY_SEARCH_UNAVAILABLE/NO_COMPONENT_LIBRARY_INVENTORY_API` for live inventory and `UNKNOWN_OUTCOME/TIMEOUT_PENDING` for the uncancellable unpublished-key import observation bound;
- deletion followed by document-tree component search/bounded node query for the set canary and tracked-ID/name query for the physical slot canary, both with zero remaining `MCP1155` nodes.

A successful live import of a real published key still requires an enabled library and stable key in the target account. That account-specific gate remains visible rather than being inferred from fixture success.
