# Figma Console MCP tool audit

## Scope and evidence

This audit covers the **NPX / Local Git mode** tool surface of Figma Console MCP, because that is the 113-tool surface MCP Fig intends to simplify.

- Upstream: <https://github.com/southleft/figma-console-mcp>
- Audited commit: [`0a49662`](https://github.com/southleft/figma-console-mcp/commit/0a49662a2e4111da7795841f9fb6925de273163f)
- Package version: `1.37.1`
- Audit date: 2026-07-25
- Upstream claims: Local/NPX **113**, Cloud **101**, Remote SSE **9** in [README capability differences](https://github.com/southleft/figma-console-mcp/blob/0a49662a2e4111da7795841f9fb6925de273163f/README.md#L47-L61).
- Runtime verification: clean `npm ci`, `npm run build:local`, then MCP SDK `tools/list` against `dist/local.js`; result: **113 unique tools**.

The inventory below is source- and runtime-grounded. “Core/optional/advanced” is an MCP Fig recommendation, not an upstream label. “Legacy” is intentionally not assigned: the audited source does not provide enough evidence to call a tool legacy. Deprecation should require upstream markers or usage telemetry.

## Findings

1. **The 113-tool count is real.** It is not just README marketing; the local server returned 113 unique names at runtime.
2. **Most inflation comes from capability granularity, not duplicate implementation.** Write-tool module registrations (31), Slides (17), direct `local.ts` registrations (16), and FigJam (10) account for 74 registrations.
3. **There are clear facade candidates.** Screenshot, document views, component inspection, token CRUD, node mutation, audits, history, Slides, and FigJam can be grouped behind domain tools with explicit `action` discriminators.
4. **Auto Layout has no first-class typed tool.** Layout work is spread across `figma_execute`, `figma_create_child`, resize/move calls, and FigJam-only `figjam_auto_arrange`. This is the largest functional gap for MCP Fig, not merely a naming problem.
5. **Raw execution is powerful but high-risk.** `figma_execute` can bypass domain validation and must remain an advanced fallback, not a default editing path.
6. **Tool count can drop without deleting capabilities.** The 113 registrations map cleanly to 13 proposed default facades plus optional profiles for collaboration, history, FigJam, Slides, and debugging.

## Counts

### By domain

| Domain | Tools |
|---|---:|
| Advanced | 1 |
| Annotations | 3 |
| Audit | 5 |
| Comments | 3 |
| Components | 21 |
| Connection | 5 |
| Debugging | 4 |
| Document | 5 |
| FigJam | 10 |
| History | 6 |
| Instances | 2 |
| Nodes | 10 |
| Screenshot | 2 |
| Selection | 1 |
| Slides | 17 |
| Styles | 1 |
| Tokens | 17 |

### Recommended exposure

| Exposure | Tools | Meaning |
|---|---:|---|
| advanced | 1 | raw escape hatch |
| core | 56 | available through default facades |
| optional | 56 | loaded only for a matching profile/workflow |

### Effects

| Effect | Tools |
|---|---:|
| control/write | 4 |
| destructive/high | 8 |
| read | 51 |
| write | 50 |

## Top 10 workflow trace

| # | Common workflow | Current tools | Current calls | MCP Fig route | Target calls |
|---:|---|---|---:|---|---:|
| 1 | Connect and select the active file | `figma_list_open_files` → `figma_navigate` → `figma_get_status` | 2–3 | `figma_connection(action: "target")` | 1 |
| 2 | Inspect the current selection in document context | `figma_get_selection` → `figma_get_file_data` | 2 | `figma_selection(action: "inspect", includeContext: true)` | 1 |
| 3 | Build or repair Auto Layout | usually `figma_execute`; otherwise `figma_create_child` + resize/move calls | 1–many, weak schema | `figma_layout(action: "inspect|apply|sizing|batch|validate|repair")` | 1–3 |
| 4 | Update a node’s geometry and appearance | `figma_resize_node`, `figma_move_node`, `figma_set_fills`, `figma_set_strokes`, `figma_set_text` | 1–5 | `figma_node(action: "update", patch: …)` | 1 |
| 5 | Find and instantiate a component | `figma_search_components` → `figma_get_component_details` → `figma_instantiate_component` → `figma_set_instance_properties` | 3–4 | `figma_component(action: "find")` → `figma_instance(action: "create", properties: …)` | 2 |
| 6 | Create a component set and properties | `figma_create_component_set` → `figma_arrange_component_set` → add/edit property → `figma_set_description` | 3–5 | `figma_component(action: "createSet", …)` | 1–2 |
| 7 | Read and update variables | `figma_get_variables` → collection/mode/create/update/batch tools | 2–many | `figma_tokens(action: "inspect|apply", operations: …)` | 1–2 |
| 8 | Verify a visual change | `figma_take_screenshot` or `figma_capture_screenshot` → one or more lint/audit tools | 2–3 | `figma_audit(action: "verify", screenshot: true)` | 1 |
| 9 | Read/write review context | comment tools + annotation tools | 1–many | optional `collaboration` profile: `figma_collaboration` / `figma_annotation` | 1–2 |
| 10 | Understand changes over time | versions → diff/changes → changelog/blame | 2–4 | optional `history` profile: `figma_history(action: …)` | 1–2 |

The target call counts are design goals to validate in task #1075, not measured implementation results yet.

## Recommended consolidation

### Default facade surface (13 tools)

1. `figma_connection`
2. `figma_document`
3. `figma_selection`
4. `figma_node`
5. `figma_layout`
6. `figma_component`
7. `figma_instance`
8. `figma_tokens`
9. `figma_styles`
10. `figma_screenshot`
11. `figma_audit`
12. `figma_annotation`
13. `figma_execute` — advanced fallback; hide unless explicitly enabled if the client supports dynamic tool profiles

`figma_layout` is new first-class functionality rather than a rename of an upstream tool. Collaboration, history, FigJam, Slides, and verbose plugin-debugging actions should be optional profiles. Destructive actions remain inside their domain facade but require an explicit action, exact target IDs, and preferably `dryRun`/precondition support.

### Duplication and overlap decisions

- Merge `figma_take_screenshot` and `figma_capture_screenshot` behind one screenshot tool with a source/strategy option.
- Turn file/summary/kit/plugin variants into views on `figma_document` rather than separate names.
- Turn component/details/development/deep/library variants into `figma_component.inspect` with depth and source options.
- Turn individual node setters into one typed patch action; keep clone/delete/create as explicit actions.
- Turn variable CRUD/batch/setup/import/export into discriminated `figma_tokens` actions. Do not use one loose `payload: any` schema.
- Keep audit types as explicit `figma_audit` actions because their inputs and outputs differ, but avoid separate MCP registrations.
- Keep Slides and FigJam internally granular if useful; expose each through one optional profile facade.
- Do not delete or label upstream tools legacy until compatibility needs and usage data are known. MCP Fig is a new server, so it can start with facades without carrying old public names.

## Safety rules carried into API design

- `figma_execute`, imports with replace/delete behavior, and every delete action are high-risk.
- Require exact IDs for destructive operations; reject broad implicit-selection deletes.
- Provide `dryRun` for batch layout/token operations and return a normalized change set.
- For multi-node writes, return atomic/rollback status or an explicit partial-result list.
- Separate read schemas from write schemas so an agent cannot accidentally mutate through an inspect action.

## Complete 113-tool inventory

| Tool | Domain | Effect | Exposure | Overlap candidate | MCP Fig target |
|---|---|---|---|---|---|
| `figjam_auto_arrange` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_create_code_block` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_create_connector` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_create_section` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_create_shape_with_text` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_create_stickies` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_create_sticky` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_create_table` | FigJam | write | optional | figjam facade | `figma_figjam` |
| `figjam_get_board_contents` | FigJam | read | optional | figjam facade | `figma_figjam` |
| `figjam_get_connections` | FigJam | read | optional | figjam facade | `figma_figjam` |
| `figma_add_component_property` | Components | write | core | — | `figma_component` |
| `figma_add_mode` | Tokens | write | core | — | `figma_tokens` |
| `figma_add_shape_to_slide` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_add_slot_property` | Components | write | core | — | `figma_component` |
| `figma_add_text_to_slide` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_analyze_component_set` | Components | read | optional | — | `figma_component` |
| `figma_append_to_slot` | Components | write | core | — | `figma_component` |
| `figma_arrange_component_set` | Components | write | core | — | `figma_component` |
| `figma_audit_component_accessibility` | Audit | read | optional | audit family | `figma_audit` |
| `figma_audit_design_system_report` | Audit | read | optional | audit family | `figma_audit` |
| `figma_batch_create_variables` | Tokens | write | core | token creation | `figma_tokens` |
| `figma_batch_update_variables` | Tokens | write | core | token updates | `figma_tokens` |
| `figma_blame_node` | History | read | optional | history facade | `figma_history` |
| `figma_capture_screenshot` | Screenshot | read | core | screenshot overlap | `figma_screenshot` |
| `figma_check_design_parity` | Audit | read | optional | audit family | `figma_audit` |
| `figma_clear_console` | Debugging | control/write | optional | — | `figma_connection` (debug actions) |
| `figma_clone_node` | Nodes | write | core | node facade | `figma_node` |
| `figma_create_child` | Nodes | write | core | node facade | `figma_node` |
| `figma_create_component_set` | Components | write | core | — | `figma_component` |
| `figma_create_slide` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_create_slot` | Components | write | core | — | `figma_component` |
| `figma_create_variable` | Tokens | write | core | token creation | `figma_tokens` |
| `figma_create_variable_collection` | Tokens | write | core | — | `figma_tokens` |
| `figma_delete_comment` | Comments | destructive/high | optional | collaboration facade | `figma_collaboration` |
| `figma_delete_component_property` | Components | destructive/high | core | — | `figma_component` |
| `figma_delete_node` | Nodes | destructive/high | core | node facade | `figma_node` |
| `figma_delete_slide` | Slides | destructive/high | optional | slides facade | `figma_slides` |
| `figma_delete_variable` | Tokens | destructive/high | core | — | `figma_tokens` |
| `figma_delete_variable_collection` | Tokens | destructive/high | core | — | `figma_tokens` |
| `figma_diagnose` | Connection | read | core | — | `figma_connection` |
| `figma_diff_versions` | History | read | optional | history facade | `figma_history` |
| `figma_duplicate_slide` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_edit_component_property` | Components | write | core | — | `figma_component` |
| `figma_execute` | Advanced | destructive/high | advanced | — | `figma_execute` |
| `figma_export_tokens` | Tokens | read | optional | token reads/exports | `figma_tokens` |
| `figma_focus_slide` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_generate_changelog` | History | read | optional | history facade | `figma_history` |
| `figma_generate_component_doc` | Components | read | optional | — | `figma_component` |
| `figma_get_annotation_categories` | Annotations | read | optional | annotation facade | `figma_annotation` |
| `figma_get_annotations` | Annotations | read | optional | annotation facade | `figma_annotation` |
| `figma_get_changes_since_version` | History | read | optional | history facade | `figma_history` |
| `figma_get_comments` | Comments | read | optional | collaboration facade | `figma_collaboration` |
| `figma_get_component` | Components | read | core | component inspection | `figma_component` |
| `figma_get_component_details` | Components | read | core | component inspection | `figma_component` |
| `figma_get_component_for_development` | Components | read | core | component inspection | `figma_component` |
| `figma_get_component_for_development_deep` | Components | read | optional | component inspection | `figma_component` |
| `figma_get_component_image` | Components | read | core | — | `figma_component` |
| `figma_get_console_logs` | Debugging | read | optional | — | `figma_connection` (debug actions) |
| `figma_get_design_changes` | Document | read | core | — | `figma_document` |
| `figma_get_design_system_kit` | Document | read | optional | document views | `figma_document` |
| `figma_get_design_system_summary` | Document | read | core | document views | `figma_document` |
| `figma_get_file_at_version` | History | read | optional | history facade | `figma_history` |
| `figma_get_file_data` | Document | read | core | document views | `figma_document` |
| `figma_get_file_for_plugin` | Document | read | optional | document views | `figma_document` |
| `figma_get_file_versions` | History | read | optional | history facade | `figma_history` |
| `figma_get_focused_slide` | Slides | read | optional | slides facade | `figma_slides` |
| `figma_get_library_component_by_key` | Components | read | core | component inspection | `figma_component` |
| `figma_get_library_components` | Components | read | core | component discovery | `figma_component` |
| `figma_get_library_variables` | Tokens | read | optional | — | `figma_tokens` |
| `figma_get_selection` | Selection | read | core | — | `figma_selection` |
| `figma_get_slide_content` | Slides | read | optional | slides facade | `figma_slides` |
| `figma_get_slide_grid` | Slides | read | optional | slides facade | `figma_slides` |
| `figma_get_slide_transition` | Slides | read | optional | slides facade | `figma_slides` |
| `figma_get_slots` | Components | read | core | — | `figma_component` |
| `figma_get_status` | Connection | read | core | — | `figma_connection` |
| `figma_get_styles` | Styles | read | core | — | `figma_styles` |
| `figma_get_text_styles` | Slides | read | optional | slides facade | `figma_slides` |
| `figma_get_token_values` | Tokens | read | core | token reads/exports | `figma_tokens` |
| `figma_get_variables` | Tokens | read | core | token reads/exports | `figma_tokens` |
| `figma_import_library_variable` | Tokens | write | optional | — | `figma_tokens` |
| `figma_import_tokens` | Tokens | destructive/high | optional | — | `figma_tokens` |
| `figma_instantiate_component` | Instances | write | core | — | `figma_instance` |
| `figma_lint_design` | Audit | read | core | audit family | `figma_audit` |
| `figma_list_open_files` | Connection | read | core | — | `figma_connection` |
| `figma_list_slides` | Slides | read | optional | slides facade | `figma_slides` |
| `figma_move_node` | Nodes | write | core | node facade | `figma_node` |
| `figma_navigate` | Connection | control/write | core | — | `figma_connection` |
| `figma_post_comment` | Comments | write | optional | collaboration facade | `figma_collaboration` |
| `figma_reconnect` | Connection | control/write | core | — | `figma_connection` |
| `figma_reload_plugin` | Debugging | control/write | optional | — | `figma_connection` (debug actions) |
| `figma_rename_mode` | Tokens | write | core | — | `figma_tokens` |
| `figma_rename_node` | Nodes | write | core | node facade | `figma_node` |
| `figma_rename_variable` | Tokens | write | core | — | `figma_tokens` |
| `figma_reorder_slides` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_reset_slot` | Components | write | core | — | `figma_component` |
| `figma_resize_node` | Nodes | write | core | node facade | `figma_node` |
| `figma_scan_code_accessibility` | Audit | read | optional | audit family | `figma_audit` |
| `figma_search_components` | Components | read | core | component discovery | `figma_component` |
| `figma_set_annotations` | Annotations | write | optional | annotation facade | `figma_annotation` |
| `figma_set_description` | Components | write | core | — | `figma_component` |
| `figma_set_fills` | Nodes | write | core | node facade | `figma_node` |
| `figma_set_image_fill` | Nodes | write | core | node facade | `figma_node` |
| `figma_set_instance_properties` | Instances | write | core | — | `figma_instance` |
| `figma_set_slide_background` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_set_slide_transition` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_set_slides_view_mode` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_set_strokes` | Nodes | write | core | node facade | `figma_node` |
| `figma_set_text` | Nodes | write | core | node facade | `figma_node` |
| `figma_setup_design_tokens` | Tokens | write | core | token creation | `figma_tokens` |
| `figma_skip_slide` | Slides | write | optional | slides facade | `figma_slides` |
| `figma_take_screenshot` | Screenshot | read | core | screenshot overlap | `figma_screenshot` |
| `figma_update_variable` | Tokens | write | core | token updates | `figma_tokens` |
| `figma_watch_console` | Debugging | read | optional | — | `figma_connection` (debug actions) |

## Verification commands

```bash
# audited upstream checkout
npm ci
npm run build:local
node list-tools.mjs

# MCP Fig inventory checks
python3 scripts/verify-tool-audit.py
```

Runtime result at the audited commit: `count=113`. The upstream TypeScript build completed successfully. The inventory check must be run again whenever the pinned upstream commit changes.
