# Quality gates

MCP Fig measures its compact facade and representative workflows through the
real MCP client/server transport. The gates run in `tests/quality-gates.test.ts`
and are configured by `tests/fixtures/workflow-benchmarks.json`.

## Baseline

| Gate | Required | Current fixture baseline |
| --- | ---: | ---: |
| Core tools | 15 or fewer | 8 |
| Calls per workflow | 5 or fewer | 5 maximum |
| Auto Layout without `figma_execute` | at least 90% | 10/10 (100%) |
| Representative workflow success | all fixtures | 12/12 (100%) |

The representative set contains two general workflows and ten Auto Layout
workflows. It covers selection inspection, component → instance → token binding,
layout inspection, dry-run, nested batch ordering, validation, safe repair, and
atomic rollback.

## Schema regression

`tests/snapshots/core-tool-schemas.json` captures the complete MCP-visible schema
for every enabled core tool. The test fails when a tool is added, removed, or
changes its title, description, annotations, action discriminator, or input
fields. It also rejects empty object schemas so strict internal unions cannot
accidentally become unusable to MCP hosts.

MCP requires an object at the root of every tool input schema. MCP Fig keeps its
strict action-specific Zod unions for validation and uses `src/mcp-schema.ts` to
expose a merged object schema to clients. Unknown or action-incompatible fields
are still rejected by the original union.

## Structural visual regression

`tests/fixtures/auto-layout-visual-workflow.json` applies a nested parent/card/text
layout through one typed `figma_layout.batch` call. The resulting normalized
layout, sizing, padding, alignment, constraints, and hierarchy are compared with
`tests/snapshots/auto-layout-structural-visual.json`.

This is a deterministic structural visual assertion, not a rendered pixel
screenshot. Pixel comparison remains a live Desktop Plugin bridge responsibility;
the fixture gate prevents semantic Auto Layout regressions in CI without
pretending that REST or in-memory nodes are rendered by Figma.

## Commands

```bash
npm run quality
npm run snapshots:update
```

Run `npm run snapshots:update` only for an intentional contract change, review
the resulting JSON diff, then run the complete test suite. CI runs the quality
gates and regenerates both snapshots to ensure committed outputs are current.
