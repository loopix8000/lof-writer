# iroh 연결 진단 API

앱과 동일한 `lof-realtime` 및 iroh 1.3.0으로 실제 피어에 접속한다. PC 또는 Android의 초대 코드로 그룹에 가입한 뒤, 서명이 확인된 구성원 목록을 받아 **Android를 포함한 그룹 장치 각각에 직접 접속**한다. Android 검사를 위해 Android에서 새 그룹을 만들 필요는 없다.

PC에서 실행한 검사만으로 Android에서 시작하는 연결이나 Android 내부 파일 상태를 모두 재현했다고 판단하지 않는다. `inventory`의 상대 오류 응답과 실제 직접/중계 경로를 구분해 수집한다.

## 실행

```powershell
npm run diagnose:iroh
```

`127.0.0.1:47675`에만 열린다. Rust 진단 실행 파일은 기존 `src-tauri/target`에 빌드하고 새 버전·APK·MSI는 만들지 않는다. 이미 빌드했다면 `npm run diagnose:iroh -- --skip-build`로 시작한다.

API 인증 정보는 Git에서 제외된 `.test-data/iroh-diagnostics/runtime.json`에 저장한다. 초대 코드를 명령줄 인수로 전달하지 않는다.

## 요청

```powershell
$runtime = Get-Content .test-data/iroh-diagnostics/runtime.json -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($runtime.token)" }
$body = @{
  code = Get-Clipboard
  mode = 'inventory'
  addressMode = 'discover'
  label = 'Android 외부망'
} | ConvertTo-Json
$job = Invoke-RestMethod "$($runtime.url)/v1/probes" -Method Post -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))
Invoke-RestMethod "$($runtime.url)$($job.statusUrl)" -Headers $headers | ConvertTo-Json -Depth 20
```

`POST /v1/probes`는 바로 작업 ID를 반환한다. `GET /v1/probes/{id}`를 다시 호출하면 진행 중인 단계와 최종 결과가 나온다. 완료 보고서는 `.test-data/iroh-diagnostics/{id}.json`에도 저장된다. `GET /health`에는 현재 작업 진행 여부가 나온다. 모든 경로에 인증이 필요하다.

| 항목 | 값과 의미 |
| --- | --- |
| `mode` | `connect`(기본값): QUIC 접속만 확인. 초대 토큰을 사용하거나 가입하지 않음 |
| | `inventory`: 임시 가입 → hello → begin → inventory → end → 탈퇴 요청 |
| | `read`: inventory 후 한도 안에서 원본을 읽고 크기·SHA-256을 확인. 내용은 출력·저장하지 않음 |
| `addressMode` | `discover`(기본값): 앱의 일반 재접속처럼 Endpoint ID만으로 주소 탐색 |
| | `ticket`: 초대 코드에 담긴 직접 주소·중계 힌트도 사용. 가입 때와 재접속 때의 차이 비교용 |
| `scope` | `group`(기본값): 그룹의 다른 장치도 검사. 초대 장치 외의 Android부터 검사하며 모든 이벤트에 대상 ID 기록 |
| | `inviter`: 코드를 만든 장치만 검사 |
| `keepAlive` | 기본 `true`. 조회가 끝나거나 파일 경고가 나도 그룹에서 탈퇴하지 않고 연결을 유지. `false`일 때만 검사 종료 후 자동 탈퇴 |
| `samples` | 1~20, 기본 3. 연결 후 0.5초 간격의 관찰 시간 지정 |
| `maxFiles` | 읽기 파일 수 한도, 기본 20, 최대 256 |
| `maxBytes` | 목록에 선언된 크기를 기준으로 한 읽기 한도, 기본 25,000,000, 최대 100,000,000 |

검사는 한 번에 하나씩 시작한다. 동일한 코드로 `connect`는 반복할 수 있지만 `inventory`·`read`의 첫 가입은 일회용 초대 코드를 소비한다. 가입된 진단 작업은 `holding` 상태로 남으며 앱이 꺼지면 재접속을 시도한다. `POST /v1/probes/{id}/recheck`로 새 코드 없이 같은 가입 상태에서 재검사한다. `POST /v1/probes/{id}/leave`를 명시적으로 호출할 때만 탈퇴한다. `connect` 모드는 가입 없이 접속만 확인한 뒤 끝난다.

상대가 “다른 동기화가 진행 중입니다.”를 반환하면 같은 연결·가입 상태를 유지하며 2초 간격으로 최대 90초간 재시도한다. 한 장치의 오류가 나도 다른 장치 검사를 계속하고 장치별 결과를 기록한다. 앱의 공개키 담당 규칙상 진단 측이 비교를 시작할 수 없는 드문 경우에는 이를 명시하고 파일 조회는 건너뛴다.

## 수집하는 값

- 접속·hello·begin·inventory·파일 read·end·탈퇴 요청별 시작 시각, 소요 시간, 오류 원문
- 접속 시도 중 로컬 주소 개수·중계 접속 여부·중계 오류, 연결 후 1초마다 직접/중계 경로·주소·경로 ID, 선택 경로, RTT, 전송·수신 바이트, 패킷 손실, MTU
- 파일 개수·총 용량·실제 읽은 용량. 파일명 대신 경로 해시 사용
- 성공·실패 구분과 임시 동기화 세션 해제·그룹 탈퇴 시도 결과

전송 통계는 QUIC 제어 패킷을 포함한다. 응답 본문의 첫 바이트 도착 시간으로 해석하지 않는다. 연결 코드·개인키·그룹 비밀값과 원고 본문은 보고서에 넣지 않는다. 상대 오류 원문에는 파일명이 들어갈 수 있다.

## 상태 변경 범위

원고 쓰기·삭제·양방향 동기화는 실행하지 않는다. `inventory`·`read`는 **그룹에 임시 진단 장치를 추가**하고 짧게 동기화 세션을 연다. 상대 앱의 목록·이력 갱신이나 연결 상태 변경은 일어날 수 있다. 앱의 현재 `end` 처리 버그로 조회만 해도 마지막 동기화 시각이 갱신될 수 있으므로 완료 표시를 진단 성공 근거로 쓰지 않는다.

나가기 요청을 받은 경우에만 자신의 서명으로 제거 기록을 보낸다. 현재 앱은 제거 반영 후 재인증 오류를 반환할 수 있어 탈퇴를 확정했다고 보고하지 않는다. 연결 유지 중에는 자동 종료 타이머를 사용하지 않는다. 도구가 강제로 종료되더라도 그룹 제거 기록을 보내지는 않는다. 그룹 목록에서 남은 장치를 제거할 수 있다.

## 파일 경고의 세부 값

Android `0.0.2-alpha.3`부터 inventory 거부 시 `warnings=[...]`, `pending_missing=true/false`를 오류로 반환한다. 이전 설치본은 일반 경고 문구만 반환한다. 진단 API로 이전 설치본의 내부 DB 값을 우회해서 읽지는 않는다.

## 진단 코드 검증

```powershell
node --test tests/iroh-diagnostics.test.mjs
cargo test --offline --manifest-path crates/lof-realtime/Cargo.toml --target-dir src-tauri/target --example diagnostic_probe
```
