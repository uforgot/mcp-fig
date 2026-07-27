# Text range and image import contract

## Facade

새 top-level tool을 만들지 않는다. 기존 `figma_node` 안에 다음 typed action을 둔다.

- `text_range_read`
- `text_range_update`
- `image_import`
- `image_inspect`
- `image_fill`

Text/image read와 mutation은 Desktop Plugin-primary다. REST fallback은 range style이나 Figma-local image hash를 완전하게 표현하지 않으므로 지원을 가장하지 않는다.

## Text range

인덱스는 Figma/JavaScript와 같은 UTF-16 code unit 기준의 `[start, end)`다.

- node는 `TEXT`여야 한다.
- `0 <= start < end <= characters.length`
- read 한 range와 update 전체가 만지는 길이는 최대 10,000 code units다.
- update는 1–100개의 정렬된 non-overlapping range만 받는다.
- style은 `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, typed fill이다.
- readback은 concrete styled segments와 exact start/end/characters를 반환한다.

Range update는 변경 range의 기존 concrete segments와 fonts를 먼저 읽고 필요한 font를 모두 load한다. setter 실패 시 segment snapshot으로 rollback한다. `characters`는 변경하지 않으므로 range 밖 mixed-font characters와 style은 보존된다. Whole-node `characters` 보호 계약은 그대로 유지한다.

## Image source policy

`image_import.source`는 다음 중 하나다.

- `local`: realpath가 owner home directory 내부인 regular file
- `url`: credentials가 없고 default port를 쓰는 HTTPS URL

제한:

- path 4,096자, URL 2,048자
- URL redirect 최대 3회, 매 redirect 재검증
- DNS가 localhost, loopback, private, link-local, reserved 주소를 하나라도 반환하면 거부하며, 검증한 public address에 TLS request를 pin해 DNS rebinding을 막음
- request timeout 10초
- declared/streamed raw payload 최대 650,000 bytes. base64/JSON overhead를 포함해 broker protocol 1,000,000-byte cap 안에 머묾
- 허용 입력은 signature가 유효한 PNG, JPEG, GIF뿐
- extension과 server Content-Type은 신뢰하지 않고 bytes signature를 canonical MIME으로 사용
- Figma `createImage`가 검증하는 최대 dimension은 width/height 각각 4,096px이며 rejection은 `INVALID_ARGUMENT`
- SVG/PDF는 image-fill import MIME이 아니다. 기존 `figma_node.export`의 PNG/JPG/SVG/PDF 출력 계약은 유지한다.

host가 path/network/payload/signature를 검증한 뒤 bytes를 Plugin에 넘긴다. Plugin도 base64, 10 MiB, signature/MIME을 다시 검증한다.

## Image actions

`image_import`는 Figma image hash와 MIME, byte length, width, height를 반환한다. `image_inspect`는 기존 hash를 같은 metadata로 읽는다.

`image_fill`은 `append` 또는 explicit `replace` index를 사용하고 `FILL`, `FIT`, `CROP`, `TILE` scale mode를 지원한다. 모든 target과 fill index를 사전검증한다. mixed fills는 거부하며 setter 실패 시 concrete fills snapshot으로 batch rollback한다. 성공 응답은 image metadata와 exact node readback을 반환한다.
