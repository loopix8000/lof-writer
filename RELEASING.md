# Windows 설치형 릴리즈와 업데이트

현재 저장소와 서명 키는 연결하지 않았다. 기본 설정의 업데이트 주소와 공개키는 비어 있으며, 이 상태에서는 업데이트 요청을 보내지 않는다. 앱의 설정 > 앱 업데이트에서 준비 상태를 확인할 수 있다.

## 앱의 동작

- 시작 시 새 버전을 확인하는 설정과 수동 확인 버튼을 제공한다.
- 새 버전 안내에서 다운로드·설치를 직접 시작한다.
- 다운로드가 끝나면 편집과 단축키를 잠그고 원고·메모 저장이 완료될 때까지 기다린다.
- 한글 조합, 저장 실패, 충돌, 진행 중인 작업이 있으면 설치를 중단하고 편집 화면으로 돌아간다.
- 서명을 검증한 설치 파일을 MSI 설치 프로그램으로 실행한다. Windows 앱은 종료되고 설치 완료 후 다시 실행된다.

## 나중에 저장소를 연결할 때

1. Tauri 서명 키를 만든다. 비밀키는 소스에 넣지 않고 별도로 백업한다. `.private/`는 Git에서 제외되어 있다.

   ```powershell
   New-Item -ItemType Directory -Force .private
   node node_modules/@tauri-apps/cli/tauri.js signer generate --ci -w .private/updater.key
   ```

2. GitHub Actions 설정에 다음 값을 등록한다.

   | 종류 | 이름 | 값 |
   | --- | --- | --- |
   | Variable | `TAURI_UPDATER_PUBLIC_KEY` | 생성한 `.pub` 파일 내용 |
   | Variable | `TAURI_UPDATER_ENDPOINT` | 업데이트 JSON의 HTTPS 주소 |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY` | 비밀키 파일 내용 |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 비밀키에 암호를 설정했다면 그 암호 |

3. `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`의 버전을 함께 올린다. 준비 스크립트는 버전이 다르면 빌드를 중단한다. MSI 내부 버전인 `bundle.windows.wix.version`도 숫자 형식으로 맞춘다. 현재 앱 버전 `1.0.0-beta.1`에 대응하는 MSI 내부 버전은 `1.0.0.1`이다.
4. GitHub Actions의 **Build Windows MSI release**를 수동 실행한다. MSI, 서명, `latest.json`을 포함한 초안 릴리즈가 생성된다. 검사한 뒤 릴리즈를 공개한다.

정식 릴리즈의 업데이트 주소는 `https://github.com/OWNER/REPO/releases/latest/download/latest.json` 형식으로 사용할 수 있다. GitHub의 Latest에는 prerelease가 포함되지 않으므로, 베타 배포에는 별도 고정 채널의 JSON 주소가 필요하다. 현재 워크플로는 버전별 릴리즈에 JSON을 업로드하며, 별도 베타 채널을 갱신하는 작업은 저장소·채널이 정해진 뒤 연결한다.

소스 저장소와 공개 배포 저장소를 분리할 경우에는 워크플로의 업로드 대상과 해당 저장소에 접근할 토큰도 함께 설정한다. 기본 워크플로의 대상은 실행 중인 저장소다.

## 로컬에서 서명된 MSI를 빌드할 때

위 공개키·업데이트 주소와 `TAURI_SIGNING_PRIVATE_KEY`를 환경 변수로 설정하고 다음 명령을 순서대로 실행한다.

```powershell
npm run updater:prepare
npm run tauri build -- --bundles msi --config src-tauri/tauri.updater.generated.json
```

생성된 설정 파일은 Git에서 제외된다. 비밀키는 이 파일에 기록하지 않는다. 업데이트 가능한 배포본을 만들 때는 반드시 이 설정을 포함해 빌드한다. 일반 `npm run build`는 프론트엔드 검사이며 MSI나 업데이트 파일을 만들지 않는다.

배포 전에는 이전 설치형 버전에서 새 버전으로 업데이트하고, 원고·메모·설정 보존과 저장 실패 시 설치 중단을 확인해야 한다. 현재 포터블 실행 파일에는 이 기능이 없으므로 첫 설치형 버전은 직접 설치해야 한다.
