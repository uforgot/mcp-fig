# Node query and visual property contract

이 문서는 `figma_node.query`, typed visual property write/readback, mixed value, unsupported value, batch validation 정책의 기준이다.

## Bounded node query

`figma_node`의 `query` action은 새 top-level tool이 아니다. 기존 facade 안에서 다음 selector 중 하나 이상을 요구한다.

- `name`: node name
- `nodeType`: Figma node type
- `path`: query root를 제외하고 target node까지 이어지는 exact name segment 배열

동작:

- `rootId`가 없으면 document root를 사용한다. root 자체는 결과에서 제외한다.
- traversal은 children array 기준 deterministic preorder다.
- `nameMatch`는 `exact` 또는 `contains`, `caseSensitive` 기본값은 `true`다.
- `path`는 대소문자 정책을 공유하며 전체 segment가 exact하게 같아야 한다.
- `maxDepth`는 root child를 depth 1로 세며 `0..20`, 기본 `8`이다.
- `limit`은 `1..100`, 기본 `50`이다.
- traversal은 `limit + 1`번째 match에서 즉시 중단한다. 반환 shape은 `matches`, `limit`, `truncated`다.
- 각 match는 shallow `node`와 root-relative `path`를 반환한다.
- selector 없음, 빈 path segment, bounds 초과는 `INVALID_ARGUMENT`이며 traversal을 시작하지 않는다.
- Desktop Plugin bridge에서 `node.query`는 `node.read` capability의 read-only request다. write queue/revision/idempotency path를 타지 않는다.

## Typed visual properties

`figma_node.create.props`와 `figma_node.update.patch`가 같은 schema를 사용한다.

| Property | Typed write scope | Readback |
|---|---|---|
| `fills`, `strokes` | SOLID, GRADIENT_LINEAR/RADIAL/ANGULAR/DIAMOND; channel/opacity/stop bounds 검증 | Plugin/REST paint records 보존. mixed면 `{ "mixed": true }` |
| `opacity` | finite `0..1` | number 또는 mixed sentinel |
| `cornerRadius` | finite `>= 0` uniform radius | uniform number 또는 `{ "mixed": true }`; 지원 node는 `cornerRadii` 4개 값을 함께 반환 |
| `effects` | DROP_SHADOW, INNER_SHADOW, normal LAYER_BLUR/BACKGROUND_BLUR | normalized effect array 또는 mixed sentinel |
| `blendMode` | Figma Plugin `BlendMode` enum 전체 | enum 또는 mixed sentinel |
| `constraints` | REST-style canonical horizontal `LEFT/RIGHT/CENTER/LEFT_RIGHT/SCALE`, vertical `TOP/BOTTOM/CENTER/TOP_BOTTOM/SCALE` | 같은 canonical 값 |

Plugin boundary의 constraints mapping:

- horizontal `LEFT/RIGHT/LEFT_RIGHT` ↔ Plugin `MIN/MAX/STRETCH`
- vertical `TOP/BOTTOM/TOP_BOTTOM` ↔ Plugin `MIN/MAX/STRETCH`
- `CENTER`, `SCALE`은 그대로다.

이 mapping은 `figma_node`와 `figma_layout`이 공유한다. 따라서 MCP readback은 transport가 Plugin인지 REST인지와 무관하게 canonical 값을 쓴다.

Shadow effect의 `visible`과 `blendMode` 기본값은 `true`, `NORMAL`이다. Blur effect의 `visible`과 `blurType` 기본값은 `true`, `NORMAL`이다.

## Mixed and unsupported values

- `{ "mixed": true }`는 read-only sentinel이다. write schema는 이를 받지 않는다.
- mutation target의 현재 visual patch property가 Figma `mixed`이면 whole-node visual mutation 전체를 preflight에서 거부한다. assign 불가능한 mixed sentinel을 visual rollback snapshot에 넣지 않는다.
- Figma가 내부 float32로 저장하는 visual number는 readback에서 소수점 6자리로 canonicalize한다. typed input `0.63`은 `0.629999995...`가 아니라 `0.63`으로 돌아온다.
- Plugin이 자동으로 붙이는 paint/effect default와 bound-variable metadata는 typed visual readback에서 제거하고 계약 필드만 반환한다.
- per-corner radius는 이번 item에서 readback만 지원한다. write는 uniform `cornerRadius`만 받는다.
- IMAGE/VIDEO/PATTERN/SHADER paint write는 이 schema에서 거부한다. image import/fill은 item `1154` 범위다.
- progressive blur, NOISE, TEXTURE effect write는 P0 일상 편집 범위가 아니므로 structured schema error로 거부한다.
- node가 property 자체를 지원하지 않으면 Plugin이 `INVALID_ARGUMENT`와 node ID/property를 반환한다.
- REST fallback은 query/read만 수행한다. mutation은 Desktop Plugin capability가 필요하다.

## Batch validation and rollback

`node.update` batch는 다음 순서로 동작한다.

1. MCP schema가 전체 patch를 검증한다.
2. 모든 target ID를 resolve한다.
3. 모든 target node가 visual patch의 각 property를 지원하고 현재 값이 mixed가 아닌지 사전검증한다.
4. 한 node라도 visual property가 unsupported 또는 mixed이면 mutation은 0건이다.
5. apply 전에 각 target의 assign 가능한 concrete visual patch state를 snapshot한다.
6. visual setter가 중간에 실패하면 모든 target의 concrete state를 snapshot으로 rollback한다.
7. 기존 mixed typography처럼 이번 visual 정책 밖의 복구 불가 state가 함께 있으면 성공으로 가장하지 않고 `UNKNOWN_OUTCOME`을 반환한다.
8. rollback 자체가 실패해도 `UNKNOWN_OUTCOME`을 반환한다.
9. 전부 성공한 경우에만 change record를 남기고 exact serialized readback을 반환한다.

`node.create`는 새 node에서 props를 검증하고 apply한다. 실패하면 생성 node를 제거한다.

## Verification ownership

- schema/fixture: `tests/core.integration.test.ts`
- Plugin serialization, mixed, constraints mapping, unsupported preflight, setter rollback: `tests/plugin-main.test.ts`
- transport/read classification: `src/bridge/desktop-plugin/write-coordinator.ts`
- registry/schema snapshot: `tests/snapshots/core-tool-schemas.json`
- actual Figma acceptance: disposable create → query → update → exact get readback → delete → query cleanup
