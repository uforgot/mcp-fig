# Figma Console MCP replacement capability matrix

## 목적과 판정 기준

이 문서는 Figma Console MCP를 제거하고 MCP Fig만으로 신빵의 실제 Figma Design workflow를 수행할 수 있는 완료 기준이다. Figma API 전체 복제는 목표가 아니다.

범위에서 제외한다.

- FigJam
- Figma Slides
- cloud write relay
- MCP Apps

우선순위와 상태는 다음 의미로 사용한다.

- **P0**: Console MCP 제거를 막는 workflow. 전부 `complete`이고 live acceptance gate를 통과해야 한다.
- **P1**: 유용하지만 현재 workflow에서 Console MCP 제거를 막지 않는 범위.
- **complete**: 현재 등록된 MCP tool schema와 구현이 있고, 요구된 live gate 근거가 있다.
- **partial**: 일부 구현은 있지만 required action, schema, live evidence 중 하나 이상이 부족하다.
- **missing**: 실제 등록 tool/action으로 수행할 수 없다. config/profile 이름만 있는 경우도 `missing`이다.
- **not-needed**: 의도적으로 replacement 범위에서 제외한다. raw escape hatch로 우회하지 않는다.

> **근거 표기:** `source`는 현재 repository source/schema, `runtime`은 MCP `tools/list` 또는 test runtime, `live`는 Figma Desktop Plugin을 통한 실제 read/write/readback/cleanup이다. Fixture test는 live 근거로 세지 않는다.

## 기준선

### Figma Console MCP

- upstream: <https://github.com/southleft/figma-console-mcp>
- audited revision: [`002647f`](https://github.com/southleft/figma-console-mcp/commit/002647fb639ee8b75e4554809432f4de402fa168)
- package version: `1.38.0`
- NPX / Local Git runtime `tools/list`: **113 tools, 113 unique**
- 기존 `docs/tool-audit.md`는 `1.37.1`의 동일한 113-tool surface를 상세 분류한다. 이 문서는 현재 `1.38.0` runtime으로 tool count와 이름을 다시 확인했다.

Console MCP의 113개 tool 이름 자체를 복제하지 않는다. workflow를 typed facade action으로 대체한다.

### MCP Fig: 목표 registry와 실제 등록 surface

`src/config.ts`의 `PROFILE_NAMES`는 목표/설정 vocabulary다. tool 구현 완료 목록이 아니다. 실제 MCP 등록은 `src/server.ts`와 runtime `tools/list`를 기준으로 한다.

| Profile/영역 | config에 존재 | 실제 등록 상태 |
|---|---:|---|
| `core` | yes | 아래 9개 facade가 항상 등록됨 |
| `libraries` | yes | `figma_component` library actions와 `figma_styles.library_import`를 허용. import는 known key 전용이며 local write와 분리 |
| `tokens` | yes | 새 등록 없음. `figma_tokens`는 이미 Core에 포함 |
| `collaboration`, `history`, `slides`, `figjam`, `debug`, `advanced` | yes | **등록 tool/action 없음**. 목표 이름이며 capability evidence가 아님 |

현재 실제 Core runtime/schema surface는 9개다.

| 실제 등록 tool | 현재 action |
|---|---|
| `figma_connection` | `status`, `list_files`, `target`, `reconnect`, `capabilities` |
| `figma_document` | `inspect`, `summary`, `changes` |
| `figma_selection` | `get`, `inspect` |
| `figma_node` | `get`, `query`, `text_range_read`, `text_range_update`, `image_import`, `image_inspect`, `image_fill`, `export`, `create`, `update`, `move`, `resize`, `clone`, `delete` |
| `figma_layout` | `inspect`, `apply`, `sizing`, `batch`, `validate`, `repair` |
| `figma_component` | `search`, `inspect`, `create_set`, `arrange_set`, `set_description`, `property_add`, `property_update`, `property_delete`, `slots`, `slot_create`; `libraries` profile에서 `library_search`, `library_inspect`, `library_import` 추가 |
| `figma_instance` | `inspect`, `create`, `swap`, `update`, `reset`, `slot_append`, `slot_reset` |
| `figma_tokens` | `inspect`, `apply`, `library_import`, collection/variable create-update-delete, mode add-rename-remove, set value, alias, bind/unbind |
| `figma_styles` | `inspect`, local `create`, `update`, `delete`; `libraries` profile에서 known-key `library_import` |

이 목록은 `tests/snapshots/core-tool-schemas.json`으로 고정되고 `tests/quality-gates.test.ts`와 `scripts/smoke-mcp.mjs`가 runtime registry를 검증한다.

## Replacement matrix

| Workflow | Console MCP 대표 기능 | MCP Fig 현재 실제 구현 | 상태 | 우선순위 | 후속 두두 | Acceptance gate |
|---|---|---|---|---|---|---|
| 단일 Figma Desktop 연결·파일 target | status, open files, navigate, reconnect | `figma_connection` 5 actions; persistent service와 Plugin session live 연결 확인 | **complete** | P0 | `1158`에서 장시간 운영 회귀 | `status → list_files → target → representative read`가 같은 file을 가리키고 credential 재입력 없이 성공 |
| Document·selection inspect | selection, file data, summary, design changes | `figma_document`, `figma_selection`; live selection/read가 canary에서 통과 | **complete** | P0 | `1159` 최종 E2E | current selection의 exact IDs/nodes와 document context를 1–2 calls로 읽고 Console fallback 0 |
| Node 검색·bounded traversal | component search 외 일반 node는 raw execute 의존 | `figma_node.query`: name/type/root-relative exact path selector, deterministic preorder, `maxDepth 0..20`, `limit 1..100`, `limit+1` early stop와 `truncated`; Plugin/REST/in-memory 구현 | **complete** | P0 | `1153` | live disposable frame/rectangle에서 exact path/ID, deterministic order, cleanup query 0; invalid/unbounded schema tests 통과 |
| Node create/update와 visual properties | create child, move/resize, fill/stroke/image fill, rename/text | SOLID+4 gradient fill/stroke, opacity, uniform/per-corner readback, common shadow/blur effects, blend mode, canonical constraints를 typed create/update/readback. mixed sentinel, unsupported schema, capability preflight, setter rollback 구현 | **complete** | P0 | image/range 확장은 `1154` | live create/update exact canonical readback, unsupported two-node batch mutation 0, cleanup query 0. 세부 계약은 `docs/node-query-visual-properties.md` |
| Whole-node typography | set text + raw execute | `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, horizontal/vertical alignment; whole-node mixed-font characters 보호 유지, range action과 분리 | **complete** | P0 | `1154` | mixed-font node의 range edit가 `characters`와 untouched range styles를 보존하고 whole-node plain replacement는 계속 거부 |
| Text range styling | raw execute | `figma_node.text_range_read/update`: UTF-16 `[start,end)`, 100 ranges/10,000 code unit cap, font/size/line-height/letter-spacing/fill concrete segment readback과 rollback | **complete** | P0 | `1154` | bounded range exact read/write, invalid/overlap/out-of-bounds와 mixed-font regression 통과. 세부 계약은 `docs/text-range-image-import.md` |
| Image import·image fill | image fill setter + raw execute | `figma_node.image_import/inspect/fill`: owner-home local 또는 restricted HTTPS, PNG/JPEG/GIF signature, raw 650,000 bytes, Figma hash metadata, append/replace fill와 rollback. PNG/JPG/SVG/PDF export는 기존 action 유지 | **complete** | P0 | `1154` | local/URL policy regression 및 live import → inspect → append/replace → PNG export → cleanup 통과. 세부 계약은 `docs/text-range-image-import.md` |
| Node export artifact | component image, screenshot 계열 | `figma_node.export`와 owner-local artifact 저장 구현 | **complete** | P0 | `1157`에서 screenshot과 역할 분리 검증 | 실제 node를 PNG/JPG/SVG/PDF로 export하고 format/scale/payload 제한, 파일 signature, cleanup을 확인 |
| Auto Layout authoring·validation·repair | 주로 `figma_execute`와 여러 node setter; first-class typed layout 없음 | `figma_layout` 6 actions, dry-run, atomic batch, deterministic validation/repair | **complete** | P0 | `1159` 최종 E2E | live frame에 apply → exact gap/padding/sizing readback → validate 0 issues → cleanup. invalid HUG/FILL fixture는 stable issue code로 탐지 |
| Local component·variant·instance·slot | component set/property/slot/instance tools | local COMPONENT/COMPONENT_SET search/inspect, bounded set create, canonical variant/property readback, physical `ComponentNode.createSlot()`, instance inspect/create/display-key override/swap/reset/slot append-reset 구현 | **complete** | P0 | `1155` | live 4-variant set plus native SlotNode `Content#54:53`, append `1` → reset `0`, create/override/swap/default reset exact readback, cleanup 0. 세부 계약은 `docs/component-instance-library.md` |
| Library component 검색·import | library components/by-key + instantiate/import | known published key `library_import` 구현. Plugin API inventory 부재는 `LIBRARY_SEARCH_UNAVAILABLE`; definite rejection은 `LIBRARY_IMPORT_FAILED`, uncancellable timeout은 `UNKNOWN_OUTCOME/TIMEOUT_PENDING`; fixture inventory 성공을 live support로 간주하지 않음 | **partial** | P0 | enabled-library account gate 필요 | fake-key timeout truthfulness와 service error preservation 통과. real stable published key 성공은 target account에 enabled library가 있어야 완료 |
| Variables·modes·aliases·bindings | variable CRUD, mode, batch, token import/export | collection/variable CRUD, mode add/rename/remove, BOOLEAN/COLOR/FLOAT/STRING per-mode values, aliases, node bind/unbind, known-key library import. whole apply prevalidation으로 invalid alias cycle/type mismatch의 선행 mutation을 차단 | **complete** | P0 | `1156` | Light/Dark collection에서 CRUD/modes/alias/binding exact readback과 cleanup; alias cycle/type mismatch 차단. 세부 계약은 `docs/variables-styles.md` |
| Local styles | get styles; 일부 raw execute | `figma_styles`: local paint/text/effect/grid inspect와 full create/update/delete. text font load, create cleanup, update rollback, destructive delete confirmation. published known-key import는 local write와 별도 action | **complete** | P0 | `1156` | 네 local style kind의 exact readback과 cleanup; library import/local mutation contract 분리. 세부 계약은 `docs/variables-styles.md` |
| Viewport/selection screenshot | take/capture screenshot | node export는 있으나 viewport/selection screenshot tool 없음 | **missing** | P0 | `1157` | viewport/selection/node capture 범위와 scale/payload cap을 schema로 고정하고 실제 clipping/overlap fixture를 전달 |
| Accessibility·design-system·layout visual audit | lint, component accessibility, design-system report, parity, code scan | typed layout structural validator만 있음. rendered clipping/contrast/a11y/design-system audit 없음 | **partial** | P0 | `1157` | screenshot/export/model-state proof를 분리하고 P0 clipping/overlap/contrast/a11y fixture의 known failures를 탐지하며 false positive baseline 기록 |
| Multi-file·restart·sleep-wake 운영 | open files, reconnect, reload/diagnose | persistent service, target/session/reconnect와 focused canary는 있음. multi-file·restart·sleep-wake 통합 gate 미완료 | **partial** | P0 | `1158` | listener 1, latest-ready session routing, stale cleanup, service/MCP/Plugin restart, macOS sleep-wake 뒤 representative read/write/readback/cleanup |
| Final no-fallback replacement | Console MCP 자체 | 개별 domain evidence는 있으나 전체 P0 sequence와 fallback 0 증명 전 | **partial** | P0 | `1159`, 제거는 `1160` | 모든 P0가 complete; 같은 fixture E2E, exact readback + screenshot/export proof, restart 후 재실행, unresolved fallback 0 |
| Plugin/service diagnostics | console logs/watch/reload/clear/diagnose | service status, structured errors, trace/event log, bug report가 있음. Figma console stream은 없음 | **partial** | P1 | `1158` | 일상 장애를 status/trace/bug report로 원인 분류 가능. console stream이 꼭 필요한 사례가 나오면 별도 item으로 승격 |
| Comments·annotations | get/post/delete comments, get/set annotations | 실제 등록 없음 | **not-needed** | P1 | 없음 | 리뷰 기록은 현재 Discord/두두/쿠쿠가 source of truth. 실제 Figma comment workflow 요구가 생기기 전에는 구현하지 않음 |
| Version history·changelog·blame | versions, diff, changelog, blame | 실제 등록 없음 | **not-needed** | P1 | 없음 | version/history는 Figma UI와 Git에서 확인. authoring replacement gate에 포함하지 않음 |
| Raw arbitrary execute | `figma_execute` | 의도적으로 없음 | **not-needed** | P1 | 없음 | P0 workflow가 typed actions만으로 통과. raw code fallback 0을 `1159`에서 확인 |
| FigJam | 10 tools | 실제 등록 없음 | **not-needed** | 제외 | 없음 | scope exclusion |
| Figma Slides | 17 tools | 실제 등록 없음 | **not-needed** | 제외 | 없음 | scope exclusion |
| Cloud relay | cloud write transport | 없음 | **not-needed** | 제외 | 없음 | local Desktop Plugin/service가 production path |
| MCP Apps | dashboard/token browser app | 없음 | **not-needed** | 제외 | 없음 | scope exclusion |

## P0 release sequence

1. `1153` — Node 검색과 visual properties parity
2. `1154` — Text range와 image import parity
3. `1155` — Component·Instance·Library parity
4. `1156` — Variables·Modes·Aliases·Styles parity
5. `1157` — Screenshot·Audit·visual verification
6. `1158` — Multi-file·restart·sleep-wake 운영 gate
7. `1159` — 모든 P0 workflow를 MCP Fig만으로 같은 fixture에서 E2E 검증
8. `1160` — `1159`가 **done**인 경우에만 secret-safe rollback backup 후 Console MCP 제거

`1160` 전환 조건:

- 이 문서의 모든 P0 row가 `complete`
- 실제 Figma exact readback과 screenshot/export proof 존재
- restart 후 대표 workflow 재실행 성공
- Console MCP/raw execute/기타 fallback 0
- `hermes mcp list/test`와 새 session에서 MCP Fig의 실제 등록 tool만 노출
- production listener 1, clean Plugin/service state, rollback 절차 확인

## 현재 evidence와 한계

확인한 evidence:

- MCP Fig source: `src/server.ts`, `src/config.ts`, `src/tools/*.ts`, `src/bridge/desktop-plugin/facade.ts`, `plugin/src/*`
- MCP Fig schema/runtime: `tests/snapshots/core-tool-schemas.json`, `tests/quality-gates.test.ts`, `scripts/smoke-mcp.mjs`
- Figma Console MCP `v1.38.0`: clean clone, `npm ci`, `npm run build:local`, MCP SDK `tools/list` → `113 unique tools`
- live service status: running service, one ready Plugin session, local Draft connected
- live generic canary: selection/read/create/update/exact readback/delete/cleanup passed through persistent service IPC
- live node export canary: disposable rectangle → PNG export → private artifact save → MIME/213-byte payload/PNG signature 확인 → node/artifact cleanup
- live Auto Layout canary: the first invalid root-HUG attempt produced `HUG_WITHOUT_AUTO_LAYOUT_PARENT`; fixed-root retry returned `valid: true`, `issues: []`, exact `HORIZONTAL`, gap `17`, padding `13`, cleanup true
- live node query/visual canary: persistent service IPC에서 disposable frame/rectangle 생성, exact name/type/path query와 ID 일치, gradient create readback, fill/stroke/opacity/corner radius/shadow/blend/constraints update canonical exact readback, unsupported two-node batch `INVALID_ARGUMENT`와 선행 mutation 0, delete 후 query 0
- live text/image canary: owner-home 1×1 PNG local import, hash metadata `image/png`/68 bytes/1×1 inspect, rectangle image fill append `FIT` → replace `FILL`, PNG export 310 bytes/signature 확인. mixed-font text의 `Alpha` range만 Bold/18/24px/2%/red로 변경하고 untouched ` Beta` Regular/12/AUTO/0%/black exact readback, disposable nodes와 local source cleanup 후 query 0
- live component/instance canaries: persistent service IPC에서 disposable 2-axis/4-variant set의 `COMPONENT_SET` search/inspect, `State`/`Size` options, display-name create/override, override-preserving swap, defaults(`Continue`/`Default`/`S`) reset을 확인했다. 별도 native-slot canary는 `ComponentNode.createSlot()` → physical `SLOT 54:168`/`Content#54:53` → instance append child count `1` → reset `0`을 확인했다. inventory는 `LIBRARY_SEARCH_UNAVAILABLE/NO_COMPONENT_LIBRARY_INVENTORY_API`, fake-key 4-second observation timeout은 uncancellable이어서 `UNKNOWN_OUTCOME/TIMEOUT_PENDING`; 두 canary cleanup 모두 0
- live URL source gate: DNS-validated/pinned HTTPS로 Wikimedia PNG를 `image/png`/38,692 bytes로 fetch·signature 확인

명시적 한계:

- component/instance fixture와 live CRUD/readback은 통과했지만 fixture library inventory는 live cloud capability 근거가 아니다. Figma Plugin API는 component library 목록을 제공하지 않으며 real-key import 성공 gate는 enabled library가 있는 account에서 별도로 필요하다.
- node export와 desktop screenshot은 같은 proof가 아니다. export 구현만으로 visual verification을 `complete`로 보지 않는다.
- `PROFILE_NAMES`에 이름이 있어도 `src/server.ts`가 tool/action을 등록하지 않으면 `missing`이다.
- P0/P1은 usage telemetry 통계가 아니라 현재 backlog와 신빵의 명시된 design workflow를 바탕으로 확정한 product priority다.
- upstream temporary checkout의 `npm ci`는 audit 13건(2 low, 3 moderate, 8 high)을 보고했다. MCP Fig repository dependency 상태나 이 replacement 판정의 성공 근거로 혼동하지 않는다.
