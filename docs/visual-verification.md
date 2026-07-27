# Screenshot, audit, and visual verification

## Proof types

MCP Fig keeps three proof types separate. One cannot be substituted for another.

| Proof | Source | What it proves | What it does not prove |
|---|---|---|---|
| Node export | `figma_node.export` → Figma `node.exportAsync()` | The requested node can be rendered by Figma in PNG/JPG/SVG/PDF with the requested raster scale | The current Desktop viewport, clipping caused by surrounding nodes, panels, selection state, or Figma chrome |
| Desktop screenshot | `figma_screenshot.capture` → macOS CoreGraphics window lookup + `screencapture` | The real on-screen Figma Desktop window after optional selection/node focus | Semantic accessibility, design-system intent, hidden off-screen state, or correctness of every pixel |
| Model-state audit | `figma_screenshot.audit` → bounded Plugin traversal | Deterministic known P0 failures in native node state and bounds | Pixel analysis, gradient/image contrast, alpha/blend compositing, runtime accessibility trees, or whether overlap is intentional |

A completion claim should name the proof used. “Screenshot passed” is not valid evidence for a model-state audit, and a node export is not a Desktop screenshot.

## `figma_screenshot.capture`

### Scope

- `viewport`: captures the current on-screen Figma Desktop window without moving the viewport.
- `selection`: requires a non-empty Plugin selection. With `focus=true`, calls `figma.viewport.scrollAndZoomIntoView(selection)` before capture.
- `node`: requires `nodeIds` (1–20). With `focus=true`, focuses those nodes before capture.
- `selection` and `viewport` reject `nodeIds`; `node` rejects a missing list.

All three scopes return the full matching Figma Desktop window and include Figma chrome. `selection` and `node` are focus scopes, not synthetic image crops. The result carries `viewportBounds`, `focusNodeIds`, and available `focusBounds` so the proof is not mistaken for a node-only export.

Capture preparation creates a 15-second lease in that Figma Plugin instance. From viewport focus until host capture and release, other Plugin commands return retryable `BUSY`; expiry recovers a crashed caller.

### Bounded delivery

- PNG only.
- `scale`: 0.25–1. Downscaling uses macOS `sips`; no upscaling.
- `maxBytes`: 64,000–8,000,000 bytes; hard maximum 8 MB.
- `delayMs`: 0–2,000 after Plugin focus, default 250 ms.
- PNG signature and width/height are verified before persistence.
- Artifacts are written mode `0600` below owner-only `~/.mcp-fig/screenshots` (`0700`).
- Directory quota is 100 MB. Quota check and exclusive artifact creation are serialized across MCP processes with a bounded, stale-recoverable owner-only filesystem lock.
- A payload/signature/capture failure creates no final artifact and removes its temporary directory.

The host enumerates all layer-0 windows whose CoreGraphics owner is exactly `Figma`. It requires exactly one title equal to the Plugin file name and requires that window to be on-screen. Zero matches, duplicate-title windows, minimized windows, and off-Space windows fail closed. Current native capture is macOS-only and requires an unlocked display plus Screen Recording permission for the Hermes gateway process.

## `figma_screenshot.audit`

Audit input is always bounded:

- `rootNodeIds`: 1–20
- `maxDepth`: 0–10, default 6
- `maxNodes`: 1–500, default 250
- `maxIssues`: 1–200, default 100
- categories: `accessibility`, `design_system`, `layout`, `lint`

The result reports `inspectedNodes`, limits, `truncated`, per-category/severity summary, stable issue codes, node IDs, and bounded evidence.

### P0 checks

| Category | Stable code | Check |
|---|---|---|
| layout | `CLIPPED_CONTENT` | A direct child render/bounding box extends outside a `clipsContent=true` container |
| layout | `OVERLAP` | Visible sibling boxes intersect; normal auto-layout flow children are excluded, while absolute children remain eligible |
| accessibility | `LOW_TEXT_CONTRAST` | WCAG ratio only when text is fully contained by a direct parent with one opaque visible solid fill, `fontWeight` is concrete, text/ancestors have zero rotation, opaque normal/pass-through composition with no visible effects, and no text/ancestor bounds intersect siblings; large text is 24 px normal or 18.66 px at weight ≥700 |
| accessibility | `TEXT_TOO_SMALL` | Concrete text size below 12 px |
| accessibility | `TOUCH_TARGET_TOO_SMALL` | A node named like button/link/input/checkbox/radio/switch/icon is below 44×44 |
| accessibility | `MISSING_ACCESSIBLE_NAME` | Component/instance retains a generic default name |
| design_system | `UNBOUND_SOLID_COLOR` | Local solid fill has no variable binding |
| design_system | `UNSTYLED_TEXT` | Text has no text style |
| lint | `EMPTY_TEXT` | Text characters are empty/whitespace |
| lint | `INVISIBLE_NODE` | Inspected node is hidden |
| lint | `DUPLICATE_SIBLING_NAME` | Visible siblings share a name |

### Explicit false-positive/coverage baseline

P0 audit deliberately does not claim:

- gradient or image contrast;
- alpha compositing, effects, or blend-mode contrast;
- runtime web/mobile accessibility tree semantics;
- automatic classification of intentional overlap;
- pixel-diff or OCR analysis;
- off-scope descendants after any traversal/issue cap is reached.

Callers must inspect `truncated` and `skippedChecks`. A clean bounded audit is evidence only for the enabled checks and visited nodes.

## Verification

Automated gates:

```bash
npm test -- --run tests/plugin-main.test.ts tests/screenshot-artifact.test.ts tests/screenshot-tool.test.ts tests/desktop-plugin-bridge.test.ts
npm run typecheck
npm run typecheck:plugin
node scripts/build-plugin.mjs --check
```

Live verification must use one disposable Figma fixture and record all of the following before cleanup:

1. `figma_node.export` PNG for a specific fixture node.
2. `figma_screenshot.capture` viewport PNG from the real Desktop window.
3. Distinct artifact paths/dimensions/proof types for export and screenshot.
4. `CLIPPED_CONTENT` and `OVERLAP` from the fixture audit with exact fixture node IDs.
5. Payload-cap rejection with no new final screenshot artifact.
6. Fixture deletion and query/readback showing no disposable nodes remain.

### Live evidence — 2026-07-27

Production persistent service plus a manually launched Figma Desktop Development Plugin:

- one connected Plugin session targeted `local:0:0`;
- model-state audit reported two `CLIPPED_CONTENT` findings and the expected sibling overlap across three inspected fixture nodes;
- direct Plugin export proved the renderer clipped a `40 × 40` fixture node to `20 × 40`;
- Desktop capture produced a `1400 × 900` PNG through `screencapture`;
- oversized capture validation returned `INVALID_ARGUMENT` and left zero cap-test nodes;
- final cleanup reported zero fixture nodes and removed both generated artifacts.

The fixture used an exact `MCP Fig Visual <run-id>` prefix and did not touch pre-existing document content.
