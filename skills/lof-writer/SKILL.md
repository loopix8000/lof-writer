---
name: lof-writer
description: Lof Writer에 연결해 작품, 회차, 플롯, 메모를 조회하고 원고를 수정한다. 사용자가 Lof Writer의 서재나 열린 원고 작업을 요청할 때 사용한다.
---

# Lof Writer

로컬 원고 파일과 앱의 MCP 도구 중 작업에 맞는 수단을 선택한다.

## 도구 선택

- 문서와 본문 검색은 MCP의 `document_search`를 우선한다. 앱의 검색과 같은 결과를 반환하므로 앱에서 보이는 검색 결과와 일치한다. 여러 회차의 날짜·설정·표현을 조사할 때도 먼저 `document_search`로 범위를 좁히고, 일치한 줄만으로 맥락이 부족할 때 필요한 문서만 `document_read`로 읽는다.
- `document_search`의 검색어는 `rg`처럼 정규식으로 해석되므로 `rg`가 필요한 패턴 검색도 MCP로 한다. MCP에 연결할 수 없거나 줄 경계를 넘는 여러 줄 패턴이 필요할 때만, 작품 폴더의 Markdown 파일에 접근할 수 있으면 `rg`, `rg --files`, 로컬 파일 읽기로 보완한다.
- 본문 수정과 저장은 MCP를 우선한다. 검색으로 범위를 좁힌 뒤 저장할 문서만 `document_read`로 최신 본문과 `revision`을 확인하고 `document_apply_patch`로 수정한다. 저장 후 앱의 본문을 다시 읽고 로컬 파일에도 반영되었는지 확인한다.
- MCP 전송 연결에 문제가 있으면 앱의 [로컬 HTTP API](references/api.md)를 통해 같은 문서 도구와 revision 검증을 사용한다. 연결 오류만으로 로컬 원고를 직접 덮어쓰지 않는다.
- 제목·태그·상태·회차 순서 등 메타정보 변경은 MCP를 사용한다. 메타정보를 바꾸려고 YAML 헤더나 파일명을 직접 고치지 않는다. 문서 생성과 이력 복원 등 앱이 관리하는 작업도 MCP를 사용한다.
- 사용자가 특정 도구나 수정 방식을 지정하면 그 선택을 따른다.

MCP를 사용할 때는 Lof Writer 앱이 실행 중이어야 한다. 연결되지 않았다면 앱의 **설정 및 연결 → MCP / API → MCP 설정 복사**에서 연결 정보를 가져오도록 안내한다. MCP 연결 없이 진행해야 하면 로컬 파일 검색과 열람으로 대신한다.

## MCP로 문서 찾기와 읽기

- `library_list`로 작품과 문서 목록을 확인한다. 작품 ID는 `projectId`, 문서 ID는 `id`로 사용하며 파일명으로 ID를 추측하지 않는다.
- 제목, 태그, 본문 일부로 문서를 찾을 때는 `document_search`를 먼저 쓴다. `query`는 별도 옵션 없이 정규식으로 해석된다(`rg`와 같은 Rust 정규식 문법이며 줄마다 적용한다. 예: `^#{2,}\s`, `주인공|조연`, `\d+화`). 리터럴 `(`, `.`, `?` 등을 찾으려면 `\(`처럼 이스케이프하고, 정규식으로 올바르지 않은 검색어는 입력한 글자 그대로 찾는다. 룩어라운드와 역참조는 지원하지 않는다. `query`가 `#`으로 시작하면 태그만 찾고, `projectId`로 한 작품의 문서로 좁히며, `caseSensitive: true`로 대소문자를 구분한다.
- `document_search` 응답은 앱 검색과 같다. `projects`는 일치한 작품, `files`는 제목·경로·태그가 일치한 문서, `results`는 본문에서 일치한 문서와 `matches`(일치한 줄과 위치), `common`은 공용 메모 결과다. `truncated: true`이면 일부만 반환된 것이므로 `projectId`나 더 구체적인 검색어로 좁혀 다시 찾는다.
- 대상 문서를 정한 뒤 `document_read`로 현재 본문과 `revision`을 읽는다. 문서 `id`와 `projectId`는 검색 결과에서 가져온다.
- `truncated: true`인 응답은 본문의 일부다. `offset`, `limit`, `totalLength`는 UTF-16 코드 단위이며, 이어 읽는 동안 `revision`이 바뀌면 다시 읽는다. 일부만 읽은 본문으로 전체 문서를 덮어쓰지 않는다.

## MCP로 원고 수정과 생성

- 본문을 일부만 고치든 여러 구간을 고치든 `document_apply_patch`만 쓴다. `document_patch`는 호환성을 위해 남아 있을 뿐이므로 사용하지 않는다. 한 문장만 바꿀 때도 구간 하나로 작성한다. 패치는 `@@` 구간과 공백 문맥 줄, `-` 삭제 줄, `+` 추가 줄로 작성한다. 문맥은 원본 본문에서 유일하게 일치해야 하고 구간이 겹치면 하나로 합친다. 하나라도 실패하면 전체를 저장하지 않는다. 형식과 예시는 [문맥 패치](references/api.md#문맥-패치)를 참고한다.
- `document_update`, `document_apply_patch`, `history_restore`에는 직전에 읽은 `revision`을 `expectedRevision`으로 전달한다. 저장 후 후속 수정에는 새로 반환된 `revision`을 쓴다.
- `CONFLICT`가 나면 최신 문서를 읽고 요청한 수정과 비교해 다시 적용한다. 이전 본문에 새 revision만 붙여 덮어쓰지 않는다.
- 전체 본문 교체가 필요한 경우에만 `document_update`의 `body`를 쓴다. 요청하지 않은 문장, Markdown 서식, 태그, 속성, 줄바꿈 방식은 보존한다.
- 새 문서는 `document_create`로 만든다. `kind`는 `episode`(회차), `plot`(플롯), `memo`(메모)를 명시한다. 플롯·메모의 `folder`는 `doc/` 아래 상대 경로이며 `doc/` 접두사는 제외한다. 회차에 연결할 때는 같은 작품의 실제 회차 ID를 `episodeId`로 전달한다.
- 회차 순서 변경은 `document_reorder`, 이력 조회와 복원은 `history_list`, `history_read`, `history_restore`를 사용하며 요청한 범위에서만 수행한다.

도구의 오류 여부를 확인하고 저장이 성공한 작업만 완료했다고 알린다. 연결 오류는 앱 실행 상태와 MCP 연결 상태를 확인한다.

## 로컬 HTTP API

MCP 대신 HTTP API를 사용하는 작업이면 [API 연결 방법](references/api.md)을 읽는다. 도구 이름과 인자는 현재 앱에서 함께 내보낸 [도구 스키마](references/tools.json)를 참고한다.
