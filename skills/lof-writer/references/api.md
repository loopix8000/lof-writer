# Lof Writer 로컬 API

앱의 **설정 및 연결 → MCP / API → API 연결 정보 복사**에서 현재 앱의 `url`과 `headers`를 가져온다. 포트와 인증 키를 고정하거나 추측하지 않는다. 앱이 다시 실행되면 연결 정보가 바뀔 수 있다.

복사한 `url`로 HTTP POST 요청을 보내며, `headers.Authorization`을 그대로 사용하고 `Content-Type: application/json`을 지정한다. 요청은 다음 구조다.

```json
{
  "name": "document_read",
  "arguments": {
    "id": "library_list에서 확인한 문서 ID"
  }
}
```

먼저 `{"name":"library_list","arguments":{}}`를 호출해 사용할 ID를 확인한다. 사용할 도구와 인자는 이 폴더의 [tools.json](tools.json)에 정의되어 있다. 도구 이름은 MCP와 동일하다.

성공 응답은 `{"result": ...}`이다. 오류 응답은 `error`와 `code`를 포함한다. HTTP 상태와 오류 내용을 확인하며, HTTP 409 또는 `code: "CONFLICT"`가 나오면 문서를 다시 읽고 수정 사항을 비교한 뒤 반영한다. 문서 수정 규칙은 [SKILL.md](../SKILL.md)와 동일하다.

이 API는 앱이 켜진 컴퓨터의 로컬 프로세스에서 사용한다. 브라우저 Origin이 있는 요청은 거절되므로 웹페이지의 fetch 대신 HTTP 요청 도구를 사용한다. 원격 AI 환경에서는 이 컴퓨터의 localhost에 직접 연결할 수 없으므로 연결 가능한 로컬 MCP나 실행 환경이 필요하다.

인증 키를 원고, 스킬 파일, 공유 자료에 기록하지 않는다. 이 다운로드 패키지에는 사용자별 인증 키나 서재 데이터가 포함되지 않는다.

## 문서 검색

`document_search`는 보관 문서와 보관 공용 메모를 기본 제외한다. 보관 문서까지 필요하면 `includeArchived: true`를 전달한다. 작품 문서의 제목·경로·태그·본문 검색과 공용 메모 검색에 모두 적용된다.

```json
{"name":"document_search","arguments":{"query":"검색어","includeArchived":true}}
```

`includeArchived`를 생략하거나 `false`로 전달하면 보관 문서를 제외한다. `projectId`는 작품 문서의 범위를 좁히며, 작품 검색과 공용 메모 검색은 전체 대상이다.

## 문서 부분 조회

아래 줄 범위 조회는 연결된 앱의 `document_read` 스키마에 `startLine`·`endLine`이 있을 때 사용한다. 지원하지 않는 앱에서는 기존 `offset`·`limit`으로 읽는다. 스킬 갱신만으로 앱에 새 인자가 추가되지는 않는다.

`document_read`의 `startLine`·`endLine`으로 필요한 줄만 읽는다. 줄 번호는 **1부터 시작하며 양 끝을 포함**한다. YAML 헤더를 제외한 Markdown 본문을 기준으로 하며 `document_search`의 `results[].matches[].line`과 같다.

```json
{"name":"document_read","arguments":{"id":"문서 ID","startLine":40,"endLine":80}}
```

- `startLine`의 기본값은 1이다. `endLine`을 생략하면 시작 줄부터 최대 200줄을 읽으며 문서 끝을 넘는 끝 줄은 문서 끝으로 제한한다. 시작 줄이 전체 줄 수를 넘거나, 끝 줄이 시작 줄보다 작으면 `INVALID` 오류다. 줄 번호에는 1 이상의 정수만 사용한다.
- `body`는 선택 구간의 원문이며 CRLF/LF, 빈 줄, Markdown 서식을 유지하고 줄 번호를 붙이지 않는다. `revision`과 기존 메타데이터도 반환한다. 빈 본문은 1줄이며 마지막 개행 뒤의 빈 줄도 센다.
- 응답의 `startLine`·`endLine`은 반환한 구간, `totalLines`는 전체 본문의 줄 수다. `truncated`는 전체 본문 중 일부만 반환했는지를 뜻하므로 문서 중간이나 끝 구간을 읽어도 `true`다. 요청한 구간을 모두 반환했는지는 `rangeTruncated`로 구분한다.
- `limit`은 줄 범위 조회에서도 최대 본문 길이이며 기본·최댓값은 100000 UTF-16 코드 단위다. 길이 제한으로 요청 구간이 잘리면 `rangeTruncated: true`다. 이모지는 문자 경계에서 자르며, `limit: 1`로 첫 이모지도 담을 수 없으면 `INVALID` 오류다. 마지막 반환 줄이 잘렸다면 `endLine`은 그 줄 번호다.
- `nextLine`은 이어 읽을 줄 번호이며 문서 끝이나 긴 줄 중간에서 잘린 경우 `null`이다. 긴 줄 중간에서는 `nextOffset`을 `offset`으로 전달해 문자 단위로 이어 읽는다. `offset`은 반환 구간의 절대 UTF-16 시작 위치, `nextOffset`은 반환 본문 직후의 절대 위치(본문 끝이면 `null`), `totalLength`는 전체 본문의 UTF-16 길이다. `nextLine`이 있으면 빈 마지막 줄까지 포함해 줄 단위로 이어 읽을 수 있다.
- `startLine`·`endLine`과 `offset`을 함께 지정하면 `INVALID` 오류다. 줄 범위를 생략하면 기존 `offset`·`limit` 문자 조회를 사용한다. 문자 조회의 `truncated`는 반환 위치 뒤에 본문이 남았는지를 뜻한다.

여러 구간을 읽는 동안 `revision`이 바뀌면 최신 문서를 다시 읽는다. 일부 구간만 읽은 `body`로 전체 본문을 덮어쓰지 않는다. 구간 수정에는 해당 문맥과 `revision`으로 `document_apply_patch`를 사용한다.

## 스킬 설치·업데이트

이 앱이 제공하는 Lof Writer 스킬만 다룬다. 스킬 패키지는 실행 중인 앱에 포함된 안내문과 현재 도구 스키마로 구성되며 인증 키나 원고를 담지 않는다. 앱을 업데이트한 뒤 새 스킬이 포함됐는지 확인할 수 있다.

- `skill_status {}`는 패키지의 `version`, 내용 기준 SHA-256 `revision`, 파일 목록을 반환한다.
- `skill_get {}`는 `files`에 상대 `path`와 UTF-8 `content`를 반환한다. 클라이언트가 기억한 `knownRevision`을 전달해 같으면 `unchanged:true`이고 파일 내용 전송을 생략한다.
- PC의 `skill_status {"skillsDirectory":"AI의 스킬 폴더 절대 경로"}`는 그 아래 `lof-writer` 설치본의 `installed.exists`, `installed.revision`, `installed.version`, `installed.upToDate`도 반환한다. ZIP으로 수동 설치한 기존 스킬도 내용으로 비교한다. 설치 기록이 없으면 `installed.version`은 `null`일 수 있다.
- PC의 `skill_install`에는 확인한 `skillsDirectory`와 패키지 `revision`을 `expectedRevision`으로 전달한다. 기존 폴더가 있으면 `installed.revision`도 `expectedInstalledRevision`으로 전달한다. 확인 후 내용이 바뀌면 `SKILL_CHANGED`를 반환하므로 다시 조회한다. 같으면 `changed:false`로 건너뛴다.
- 업데이트는 기존 `lof-writer` 폴더 전체를 스킬 검색 경로 밖에 백업한 뒤 공식 파일로 교체한다. 사용자 지정 파일도 `backupPath`에 남으며 자동 삭제하지 않는다. 결과의 `installed.upToDate`가 `true`인지 확인한다. 교체 실패 시 기존 설치본으로 되돌린다.

`skillsDirectory`는 **앱이 실행 중인 기기의 경로**다. AI 클라이언트의 실제 스킬 경로를 확인하고, 사용자 요청에 따라 설치·업데이트한다. 경로를 추측하거나 개인 설정을 임의로 변경하지 않는다. 앱과 다른 기기에서 실행되는 AI나 Android 연결에서는 `skill_get`으로 파일을 받은 뒤 AI 쪽의 스킬 폴더에 설치한다. 받은 파일은 상대 경로와 `content`의 개행을 유지해 UTF-8(BOM 없음)으로 저장하고 `sha256`을 비교한다. 설치한 내용은 스킬 새로고침 또는 새 세션부터 적용된다.

## PC 앱 업데이트

MCP와 HTTP API에서 같은 `update_status`, `update_check`, `update_install` 도구를 사용한다. 앱 설정에서 선택한 업데이트 채널을 따르며, 설치는 사용자가 앱 업데이트를 요청한 경우에 실행한다.

1. `{"name":"update_check","arguments":{}}`로 확인을 요청한다.
2. `update_status`를 조회해 `phase`가 `pending` 또는 `checking`에서 벗어날 때까지 기다린다. `error`와 해당 요청의 `lastRequest.error`를 확인하고, 업데이트가 있으면 `availableVersion`을 읽는다. `ready:false`이면 앱 화면을 준비한 뒤 다시 요청한다.
3. `{"name":"update_install","arguments":{"expectedVersion":"확인한 availableVersion"}}`로 설치를 요청한다. 후보 버전이 바뀌면 다시 확인해야 한다. 다운로드 후 열린 원고와 메모를 저장하며, 저장 실패 시 설치를 중단한다.
4. 요청 응답의 `requested:true`는 접수만 뜻한다. `update_status`의 `phase`, `progress`, `lastRequest`로 진행과 오류를 확인한다. 설치 시 앱과 연결이 종료될 수 있으며, 다시 연결한 뒤 `currentVersion`이 요청한 버전인지 확인해야 완료로 판단한다.

확인·설치는 즉시 접수 응답을 반환한다. 다른 업데이트 작업이 진행 중이면 `UPDATE_BUSY`, 업데이트 후보가 달라졌으면 `UPDATE_CHANGED` 오류를 반환한다. 설치 전 저장 단계부터 설치가 끝날 때까지 MCP 문서 변경은 `UPDATE_BUSY`로 거절한다.

## 문맥 패치

MCP의 `document_apply_patch`와 HTTP API의 같은 이름 도구는 `id`, `expectedRevision`, `patch`를 받는다. `document_read`에서 확인한 원본 본문을 기준으로 여러 구간을 한 번에 수정한다.

```json
{
  "name": "document_apply_patch",
  "arguments": {
    "id": "document_read에서 확인한 문서 ID",
    "expectedRevision": "document_read에서 확인한 revision",
    "patch": "@@\n 앞 문맥\n-이전 문장\n+새 문장\n 뒤 문맥\n@@\n 다른 앞 문맥\n-다른 이전 문장\n+다른 새 문장\n 다른 뒤 문맥"
  }
}
```

- 각 구간은 줄 번호 없는 `@@` 한 줄로 시작한다. 공백 한 칸은 그대로 둘 문맥, `-`는 삭제, `+`는 추가를 뜻한다. 빈 문맥 줄은 공백 한 칸, 빈 삭제·추가 줄은 `-`·`+`만 쓴다. 들여쓰기와 줄 끝 공백까지 정확히 비교한다.
- 파일 경로, `*** Begin Patch` 같은 파일 패치 래퍼, 파일 생성·삭제·이동, 메타데이터 변경은 받지 않는다. 제목 변경은 `document_update`를 쓴다.
- 각 구간의 문맥과 삭제 줄 전체가 원본 본문의 연속된 줄에 정확히 한 번 일치해야 한다. 위치가 중복되면 문맥을 더 포함한다. 본문 끝으로 한정하려면 마지막 구간의 마지막 줄에 `*** End of File`을 붙인다.
- 구간은 모두 수정 전 원본에서 찾는다. 문맥을 포함한 구간 범위가 겹치면 하나로 합친다. 문맥 없이 `+` 줄만 쓰는 패치는 빈 본문에 단일 구간을 적용할 때만 허용한다.
- 기존 문맥 줄의 CRLF/LF와 수정 범위 밖 본문은 보존한다. 추가 줄은 구간의 줄바꿈을 따른다. 구간 안에 줄바꿈이 없다면 가까운 기존 줄바꿈을 쓰고, 본문에 줄바꿈이 전혀 없으면 LF를 쓴다. 본문 끝을 수정할 때 마지막 출력 줄은 원래 끝 줄의 줄바꿈 유무를 따른다. 패치 문자열 자체의 마지막 개행은 본문에 추가하는 줄이 아니다.
- revision 불일치는 `CONFLICT`, 형식·문맥·구간 중복 오류는 `INVALID`다. 저장 전 모든 구간을 검증하며 하나라도 실패하면 본문과 이력을 저장하지 않는다. 기존 완료 원고 보호와 저장·이력 정책을 적용한다.

성공하면 저장된 문서와 새 `revision`, 적용한 구간 수인 `appliedHunks`를 반환한다. 이후 수정에는 반환된 revision을 사용한다.
