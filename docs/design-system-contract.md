# Component, instance, and token contract

## Tool surface

MCP Fig keeps design-system work in three facade tools rather than expanding each operation into a separate MCP tool.

- `figma_component`: `search`, `inspect`, `create_set`, `arrange_set`, `set_description`, `property_add`, `property_update`, `property_delete`, `slots`, `slot_create`
- `figma_component` with the optional `libraries` profile: `library_search`, `library_inspect`
- `figma_instance`: `create`, `update`, `slot_append`, `slot_reset`
- `figma_tokens`: `inspect`, `apply`, `collection_create`, `collection_delete`

Unknown fields and unavailable profile actions are rejected by the MCP input schema.

## Component identity policy

Local and library components are deliberately not given interchangeable fake IDs.

- A local component has `source: "local"` and a Figma `nodeId`. Its stable component `key` is returned when available.
- A library component has `source: "library"` and must have a stable `key`. It may include `libraryName`; it does not receive a synthetic local node ID.
- Local `search` and `inspect` are part of Core.
- `library_search` and `library_inspect` are only present when the `libraries` profile is enabled.
- Instance creation accepts either a local `componentId` or stable `componentKey`; at least one is required.

## Instance properties and slots

Instance property values are validated against the main component definition when definitions are available.

- Boolean properties require boolean values.
- Variant options reject values outside their declared option list.
- Unknown properties are rejected for typed local components.
- `slot_append` stores stable component keys, not local node IDs.

## Variables, aliases, and modes

Token data keeps Figma's collection and mode structure explicit.

- Every variable identifies its `collectionId`, resolved type, and `valuesByMode`.
- Aliases use `{ "type": "VARIABLE_ALIAS", "id": "<variable-id>" }`.
- Alias targets must have the same resolved type.
- Direct and transitive alias cycles are rejected.
- `mode_add` and `mode_rename` require an explicit collection.
- Values and aliases require an explicit `modeId`; no implicit active mode is guessed.
- Known binding fields are type checked: fills/strokes → COLOR, size/opacity → FLOAT, visible → BOOLEAN, text → STRING.

Collection deletion and component-property deletion use deterministic dry-run plus a short-lived confirmation token bound to the exact file and target.

## Five-call workflow

The fixture integration test completes the required path in five MCP calls:

1. `figma_component.search`
2. `figma_instance.create`
3. `figma_instance.update`
4. `figma_tokens.inspect`
5. `figma_tokens.apply` with a `bind` operation

The resulting instance retains its main component identity, property overrides, and variable binding.

## Bridge behavior

`InMemoryFigmaBridge` exercises all actions deterministically. The REST bridge supports local component search and inspection through document reads. Instance mutations, token mutations, selection, and other writes remain Desktop Plugin responsibilities and return `UNSUPPORTED_BY_BRIDGE` in REST-only mode.
