---
name: lof-writer
description: Lof Writer에 연결해 작품, 회차, 플롯, 메모를 조회하고 원고를 수정한다. 사용자가 Lof Writer의 서재나 열린 원고 작업을 요청할 때 사용한다.
---

# Lof Writer

Lof Writer 앱을 실행한 상태에서 연결된 MCP 도구를 사용한다. MCP가 연결되지 않았다면 앱의 **설정 및 연결 → MCP / API → MCP 설정 복사**에서 연결 정보를 가져오도록 안내한다. 스킬을 추가하는 것만으로 MCP 연결이 설정되지는 않는다.

## 문서 찾기와 읽기

- `library_list`로 작품과 문서 목록을 확인한다. 작품 ID는 `projectId`, 문서 ID는 `id`로 사용하며 파일명으로 ID를 추측하지 않는다.
- 제목이나 본문 일부를 알고 있다면 `document_search`로 대상을 좁힌 뒤 `document_read`로 현재 본문과 `revision`을 읽는다.
- `truncated: true`인 응답은 본문의 일부다. `offset`, `limit`, `totalLength`는 UTF-16 코드 단위이며, 이어 읽는 동안 `revision`이 바뀌면 다시 읽는다. 일부만 읽은 본문으로 전체 문서를 덮어쓰지 않는다.

## 원고 수정과 생성

- 일부 문장만 바꿀 때는 `document_patch`를 쓴다. `find`에는 현재 본문에서 정확히 한 번 일치하는 글을 넣고, 중복된다면 앞뒤 문맥을 포함한다.
- `document_update`, `document_patch`, `history_restore`에는 직전에 읽은 `revision`을 `expectedRevision`으로 전달한다. 저장 후 후속 수정에는 새로 반환된 `revision`을 쓴다.
- `CONFLICT`가 나면 최신 문서를 읽고 요청한 수정과 비교해 다시 적용한다. 이전 본문에 새 revision만 붙여 덮어쓰지 않는다.
- 전체 본문 교체가 필요한 경우에만 `document_update`의 `body`를 쓴다. 요청하지 않은 문장, Markdown 서식, 태그, 속성, 줄바꿈 방식은 보존한다.
- 새 문서는 `document_create`로 만든다. `kind`는 `episode`(회차), `plot`(플롯), `memo`(메모)를 명시한다. 플롯·메모의 `folder`는 `doc/` 아래 상대 경로이며 `doc/` 접두사는 제외한다. 회차에 연결할 때는 같은 작품의 실제 회차 ID를 `episodeId`로 전달한다.
- 회차 순서 변경은 `document_reorder`, 이력 조회와 복원은 `history_list`, `history_read`, `history_restore`를 사용하며 요청한 범위에서만 수행한다.

도구의 오류 여부를 확인하고 저장이 성공한 작업만 완료했다고 알린다. 연결 오류는 앱 실행 상태와 MCP 연결 상태를 확인한다.

## 로컬 HTTP API

MCP 대신 HTTP API를 사용하는 작업이면 [API 연결 방법](references/api.md)을 읽는다. 도구 이름과 인자는 현재 앱에서 함께 내보낸 [도구 스키마](references/tools.json)를 참고한다.
