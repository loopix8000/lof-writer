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
