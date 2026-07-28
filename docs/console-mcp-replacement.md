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
| `core` | yes | 아래 10개 facade가 항상 등록됨 |
| `libraries` | yes | `figma_component` library actions와 `figma_styles.library_import`를 허용. import는 known key 전용이며 local write와 분리 |
| `tokens` | yes | 새 등록 없음. `figma_tokens`는 이미 Core에 포함 |
| `collaboration` | yes | optional `figma_collaboration` 등록. Figma REST를 통한 `comments`, `post`, `reply`를 제공 |
| `history`, `slides`, `figjam`, `debug`, `advanced` | yes | **등록 tool/action 없음**. 목표 이름이며 capability evidence가 아님 |

현재 실제 Core runtime/schema surface는 10개이며, `collaboration` profile은 optional tool 1개를 추가한다.

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
| `figma_screenshot` | `capture` (`viewport`, `selection`, `node` focus scopes), bounded `audit` (`accessibility`, `design_system`, `layout`, `lint`) |
| `figma_collaboration` (optional) | `comments`, `post`, `reply`; cloud file key와 Figma REST 권한 필요 |

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
| Library component 검색·import | library components/by-key + instantiate/import | known published key `library_import` 구현. 같은 MCP process에서 exact `inspect`로 확인한 remote component는 key-addressed idempotent import로 재사용한다. Plugin API inventory 부재는 `LIBRARY_SEARCH_UNAVAILABLE`; definite rejection은 `LIBRARY_IMPORT_FAILED`, uncancellable timeout은 `UNKNOWN_OUTCOME/TIMEOUT_PENDING` | **complete** | P0 | `1155`, final live gate `1159` | enabled HDC library component `GNB / Desktop / KR` (`62:8488`, key `0e0878…f0428`)를 `core,libraries` runtime에서 exact inspect → `library_import`하고 `source: library`, `alreadyImported: true`, fallback 0 readback |
| Variables·modes·aliases·bindings | variable CRUD, mode, batch, token import/export | collection/variable CRUD, mode add/rename/remove, BOOLEAN/COLOR/FLOAT/STRING per-mode values, aliases, node bind/unbind, known-key library import. whole apply prevalidation으로 invalid alias cycle/type mismatch의 선행 mutation을 차단 | **complete** | P0 | `1156` | Light/Dark collection에서 CRUD/modes/alias/binding exact readback과 cleanup; alias cycle/type mismatch 차단. 세부 계약은 `docs/variables-styles.md` |
| Local styles | get styles; 일부 raw execute | `figma_styles`: local paint/text/effect/grid inspect와 full create/update/delete. text font load, create cleanup, update rollback, destructive delete confirmation. published known-key import는 local write와 별도 action | **complete** | P0 | `1156` | 네 local style kind의 exact readback과 cleanup; library import/local mutation contract 분리. 세부 계약은 `docs/variables-styles.md` |
| Viewport/selection screenshot | take/capture screenshot | `figma_screenshot.capture`: Plugin viewport/selection/node focus preparation 뒤 macOS CoreGraphics로 matching Figma Desktop window를 PNG capture. 0.25–1 scale, 8 MB hard cap, private artifact/quota, failure cleanup | **complete** | P0 | `1157` | viewport/selection/node schema, real Desktop screenshot, payload cap과 cleanup regression. 세부 계약은 `docs/visual-verification.md` |
| Accessibility·design-system·layout visual audit | lint, component accessibility, design-system report, parity, code scan | `figma_screenshot.audit`: bounded native node traversal로 clipping/overlap, solid text contrast, text/touch target/name, variable/style usage와 lint P0 issue를 stable code로 반환 | **complete** | P0 | `1157` | screenshot/export/model-state proof 분리, clipping/overlap/contrast fixture 탐지, caps와 false-positive baseline. 세부 계약은 `docs/visual-verification.md` |
| Multi-file·restart·sleep-wake 운영 | open files, reconnect, reload/diagnose | persistent service, exact local Draft identity, latest-ready ownership, stale-session cleanup, bounded half-open recovery, no unknown-write retry, production operations canary 구현 | **complete** | P0 | `1158` | 두 lightweight Draft exact routing, service/MCP/Plugin restart, actual non-DarkWake sleep-wake, listener 1, credential byte 불변, recovery write/readback/cleanup 통과 (`3d20fb3`) |
| Final no-fallback replacement | Console MCP 자체 | 모든 P0 typed workflow를 active `Untitled` fixture에서 MCP Fig로 실행했고 exact readback, export/screenshot, restart smoke, cleanup을 확인 | **complete** | P0 | `1159`; 제거는 `1160` | 2026-07-28 E2E evidence 기준 P0 complete, restart 뒤 name/opacity exact readback, residual node 0, MCP Fig fallback 0. Console baseline은 같은 시점 plugin 미연결/port fallback 상태였고 mutation에 사용하지 않음 |
| Plugin/service diagnostics | console logs/watch/reload/clear/diagnose | service status, structured errors, trace/event log, bug report가 있음. Figma console stream은 없음 | **partial** | P1 | `1158` | 일상 장애를 status/trace/bug report로 원인 분류 가능. console stream이 꼭 필요한 사례가 나오면 별도 item으로 승격 |
| Comments·annotations | get/post/delete comments, get/set annotations | optional `collaboration` profile의 `figma_collaboration`이 Figma REST를 통해 file comments read/post/reply를 지원. read는 node/resolution/limit filter, post는 explicit node anchor, reply는 root comment thread를 사용. Figma API에 existing comment edit endpoint가 없고 delete·Plugin annotations는 미구현 | **partial** | P1 | edit/delete/annotations는 필요가 확인될 때 별도 진행 | collaboration profile runtime/schema와 REST contract 통과. 실제 review comment 4개 read 후 각 원본 thread에 completion reply 1개를 post하고 reply ID `1860606205`, `1860606217`, `1860606222`, `1860606235`를 readback. unknown outcome은 retry하지 않는 계약 유지 |
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

## 2026-07-28 final E2E evidence (`1159`)

Target fixture:

- Figma Desktop file: `Untitled`
- exact file key: `local:ms3n7eru-cyux2j4vvoo-kkgu2axyc28:0055006e007400690074006c00650064`
- disposable root: `MCP1159 E2E cce44bb` (`74:2862`), 최종 cleanup query `matches: []`
- production transport: MCP stdio → persistent service IPC → Figma Desktop Plugin

| P0 영역 | 실제 MCP Fig 실행과 exact evidence |
|---|---|
| connection/document/selection | `status`, `list_files`, target 유지, `document.summary`, `selection.get`, page `28:25` exact readback |
| node/query/visual | frame/rectangle/text create, bounded `MCP1159` query, gradient·stroke·opacity `0.72`·shadow·`MULTIPLY`·constraints update와 exact get/readback |
| typography/range | `Alpha Beta`의 `[0,5)`만 Inter Bold 22/30px/2%/red로 갱신하고 `text_range_read`에서 untouched ` Beta`와 분리 readback |
| image/export | owner-local PNG import → `image/png`, 88×88, 7,332 bytes inspect → image fill append `FIT` → rectangle 2× PNG export. root export `/Users/bbangbbang/.mcp-fig/exports/MCP1159-E2E-cce44bb-74-2862-2026-07-28T04-23-57-629Z-dbcc68c9.png`은 523×600 실제 renderer output |
| Auto Layout | root에 `HORIZONTAL`, gap `17`, padding `13`, counter-axis center 적용 후 inspect exact readback과 `validate: valid true, issues []` |
| component/instance/slot | 2-axis/4-variant set create/arrange/inspect, 별도 local component `74:2871`에 native SlotNode `Content#74:5`, instance append child count `1` → reset `0`, variant override/reset. 모든 disposable component/instance cleanup 완료 |
| enabled library | `core,libraries` runtime에서 `GNB / Desktop / KR` (`62:8488`) exact inspect 후 key `0e0878…f0428` import. `source: library`, `alreadyImported: true`, fallback false |
| variables/styles | `scripts/live-variables-styles-canary.mjs`: Light/Dark COLOR values, alias/binding exact readback, invalid cycle/type mismatch no-mutation, PAINT/TEXT/EFFECT/GRID create-readback-cleanup 통과 |
| screenshot/audit | `scripts/live-visual-canary.mjs`: Desktop 1400×900 screenshot, renderer clip 40×40 → 20×40, clipping 2, overlap IDs exact, payload-cap residue 0, residual nodes 0, artifacts cleanup 2. 별도 node-focus screenshot proof는 `/Users/bbangbbang/.mcp-fig/screenshots/Untitled-node-2026-07-28T04-23-48-196Z-16f51d5c.png` |
| restart/operations | production service restart 후 PID `15464`, Plugin session 1, actionable error/circuit 0. fresh lightweight smoke의 node `77:2841`을 `MCP1159 Restart Smoke PASS`, opacity `0.64`로 exact readback하고 cleanup/fallback false. `1158`의 multi-file/restart/actual sleep-wake gate는 `3d20fb3` evidence를 재사용 |

## 2026-07-28 reviewed-page hard dogfood evidence

Disposable fixture가 아닌 실제 reviewed page 작업을 같은 `Untitled` file에서 MCP Fig만으로 수행했다.

- source wireframe `62:8502`는 변경하지 않았다.
- desktop design `66:2755`는 `1920 × 5853`, root `VERTICAL`, gap `0`, fixed section wrapper 7개 구조로 완성했다.
- reference GNB instance를 유지하고 desktop footer master `80:2826`, stage-card masters `80:2848`, `80:2860`, `80:2872`, `80:2884`와 linked page instances를 사용했다.
- card row `83:2904`, card masters, footer master, component-library frame `80:2824`에 nested Auto Layout을 적용하고 native layout readback으로 확인했다.
- full-page export, component-library export, Desktop screenshot, instance/component inspect, accessibility/layout/lint audit, FFmpeg pixel comparison을 서로 다른 proof로 사용했다.
- root Auto Layout 전환 후 baseline 대비 FFmpeg difference 평균은 `0.0520364/255`였고, 육안 검증에서 section 이동·누락·중복·footer clipping이 없었다.
- mobile design `85:2460`을 별도 `390 × 5400` root `VERTICAL` frame으로 생성했다. mobile GNB, 2단 tabs, portrait overview, linked stage-card instance 4개의 1열 stack, product stack, mobile footer를 적용했다.
- mobile full-page export에서 diagram crop과 product text collision을 발견해 수정했고, 최종 export에서 card 4개 panel 수용, product/CTA 분리, footer 보존, section clipping 없음이 확인됐다.
- review comments는 optional collaboration profile로 읽었고, 원본 thread별 completion reply를 정확히 한 번 post/readback했다.
- Figma Console MCP, raw execute, browser document mutation fallback은 `0`이었다.

이 결과는 MCP Fig가 신빵의 현재 Figma Design authoring workflow에서 legacy Figma Console MCP를 대체할 수 있다는 내부 운영 판정의 근거다. public package/release readiness와는 별도 판정이다.

## Console MCP side-by-side와 fallback 판정

동일 시점·동일 Figma Desktop fixture에서 availability를 side-by-side로 확인했다. 이 비교는 latency benchmark가 아니다.

| 항목 | MCP Fig | Figma Console MCP 1.38.0 |
|---|---|---|
| active file status | `Untitled` exact local key, ready Plugin session 1 | `currentFileName: (unable to retrieve)` |
| transport | production port 3847, persistent service listener 1 | server port 9226; preferred 9223 점유로 `portFallbackUsed: true`, Desktop Bridge plugin 미연결 |
| selection/read/write | selection/read와 disposable write/readback/cleanup 성공 | selection `WebSocket not connected`; write는 실행하지 않음 |
| replacement 중 fallback | **0** | MCP Fig 실패를 Console로 재시도한 호출 **0** |

Console MCP가 같은 fixture에 연결되지 않은 상태였기 때문에 Console 결과를 성공 기준으로 보간하지 않았다. P0 결과는 전부 MCP Fig typed action의 실제 readback과 artifact proof로 판정했다. raw execute, browser Figma, Console MCP mutation은 사용하지 않았다.

### Gate 명령과 run artifact

- `node scripts/live-variables-styles-canary.mjs`
- `node scripts/live-visual-canary.mjs`
- `node dist/index.js service restart` + `/Users/bbangbbang/.mcp-fig/evidence/mcp1159-post-restart-smoke.mjs`
- `/Users/bbangbbang/.mcp-fig/evidence/mcp1159-library-gate.mjs`
- `/Users/bbangbbang/.mcp-fig/evidence/mcp1159-console-baseline.json`
- `npm run typecheck && npm run typecheck:plugin && npm test && npm run lint && npm run build`
- `npm run smoke && npm run smoke:plugin && npm run smoke:service && npm run smoke:launchd`

Final replacement E2E 당시 automated result는 28 test files / 195 tests였고 host·Plugin typecheck, lint, build, MCP·Plugin·service·launchd smoke가 통과했다. Collaboration post/reply 추가 후 현재 suite는 28 test files / 197 tests이며 2026-07-28 재실행에서 전부 통과했다. Production E2E 당시 PID `15464`가 `127.0.0.1:3847` listener 하나를 소유하고 ready Plugin session `1`, actionable error/circuit `0` 상태였다. PID 같은 process identity는 historical evidence이며 현재 상태로 해석하지 않는다.

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
- live enabled-library gate: target account의 enabled HDC library component `GNB / Desktop / KR` (`62:8488`)를 exact inspect한 뒤 같은 `core,libraries` MCP process에서 key-addressed import했다. `source: library`, `alreadyImported: true`, kind/key/name exact readback과 fallback 0을 확인했다.
- live variables/styles gate: Light/Dark collection, per-mode COLOR, alias, binding, 네 local style kind의 exact readback과 cleanup을 확인했다. invalid alias cycle/type mismatch는 `INVALID_ARGUMENT/no-mutation`이었다.
- live operations gate (`3d20fb3`): 두 lightweight Draft exact routing, service/MCP/Plugin restart, actual non-DarkWake sleep-wake, listener 1, credential byte 불변, recovery write/readback/cleanup을 확인했다.
- final replacement E2E: active `Untitled` fixture에서 모든 P0 typed workflow를 실행하고 node `74:2862` subtree와 component/instance residue 0을 확인했다. service restart 뒤 node `77:2841` name/opacity exact readback과 cleanup/fallback false를 재확인했다.
- reviewed-page hard dogfood: source `62:8502` 보존, desktop `66:2755`, mobile `85:2460`, reusable component instances, nested/root Auto Layout, comment read/post/reply, export/screenshot/audit/pixel proof를 MCP Fig only로 완료하고 fallback 0을 확인했다.
- live URL source gate: DNS-validated/pinned HTTPS로 Wikimedia PNG를 `image/png`/38,692 bytes로 fetch·signature 확인

명시적 한계:

- Figma Plugin API는 enabled component library inventory를 제공하지 않으므로 `library_search`는 의도적으로 unavailable이다. known-key import와 이미 import된 remote component의 idempotent reuse만 지원하며, fake/denied key의 `TIMEOUT_PENDING` truthfulness contract는 유지한다.
- node export와 desktop screenshot은 같은 proof가 아니다. export 구현만으로 visual verification을 `complete`로 보지 않는다.
- `PROFILE_NAMES`에 이름이 있어도 `src/server.ts`가 tool/action을 등록하지 않으면 `missing`이다.
- P0/P1은 usage telemetry 통계가 아니라 현재 backlog와 신빵의 명시된 design workflow를 바탕으로 확정한 product priority다.
- upstream temporary checkout의 `npm ci`는 audit 13건(2 low, 3 moderate, 8 high)을 보고했다. MCP Fig repository dependency 상태나 이 replacement 판정의 성공 근거로 혼동하지 않는다.
