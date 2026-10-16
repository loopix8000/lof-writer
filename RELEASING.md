# Windows 설치형 릴리즈와 업데이트

공개 배포 저장소는 `loopix8000/lof-writer`이다. 베타 업데이트 주소는 `https://github.com/loopix8000/lof-writer/releases/download/beta/latest.json`이다. Actions가 등록된 공개키와 이 주소를 빌드에 포함한다. 기본 개발 설정에는 업데이트 주소와 공개키가 비어 있으며, 앱의 설정 > 앱 업데이트에서 준비 상태를 확인할 수 있다.

## 앱의 동작

- 시작 시 새 버전을 확인하는 설정과 수동 확인 버튼을 제공한다.
- 새 버전 안내에서 다운로드·설치를 직접 시작한다.
- 다운로드가 끝나면 편집과 단축키를 잠그고 원고·메모 저장이 완료될 때까지 기다린다.
- 한글 조합, 저장 실패, 충돌, 진행 중인 작업이 있으면 설치를 중단하고 편집 화면으로 돌아간다.
- 서명을 검증한 설치 파일을 MSI 설치 프로그램으로 실행한다. Windows 앱은 종료되고 설치 완료 후 다시 실행된다.

## 서명 설정

1. Tauri 서명 키를 만든다. 비밀키는 소스에 넣지 않고 별도로 백업한다. `.private/`는 Git에서 제외되어 있다.

   ```powershell
   npm run updater:keygen
   ```

   비밀키는 `.private/updater.key`, 공개키는 `.private/updater.key.pub`에 저장한다. 기존 키가 있으면 덮어쓰지 않으며, 키 내용은 터미널에 출력하지 않는다. 이 명령으로 생성한 키에는 별도 암호가 없으므로 비밀키 암호 Secret은 생략한다.

2. GitHub Actions 설정에 다음 값을 등록한다.

   | 종류 | 이름 | 값 |
   | --- | --- | --- |
   | Variable | `TAURI_UPDATER_PUBLIC_KEY` | 생성한 `.pub` 파일 내용 |
   | Variable | `TAURI_UPDATER_ENDPOINT` | 업데이트 JSON의 HTTPS 주소 |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY` | 비밀키 파일 내용 |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 비밀키에 암호를 설정했다면 그 암호 |

3. `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`의 버전을 함께 올리고 두 잠금 파일의 앱 버전도 맞춘다. 준비 스크립트는 버전이 다르면 빌드를 중단한다. MSI 내부 버전인 `bundle.windows.wix.version`은 앱 버전과 별도로 매 릴리즈마다 증가시킨다. 현재 앱 버전 `1.0.1-beta.1`의 MSI 내부 버전은 `1.0.4`이다. [Windows Installer는 버전의 앞 세 자리만 비교](https://learn.microsoft.com/en-us/windows/win32/msi/productversion)하므로 네 번째 자리만 올리면 업그레이드를 구분할 수 없다. 기존 MSI의 UpgradeCode는 유지한다.
4. GitHub Actions의 **Build Windows MSI release**를 `main`에서 수동 실행한다. **Publish the release and update the beta channel after building**을 선택하면 MSI·서명·`latest.json`을 업로드한 뒤 공개하고 베타 채널을 갱신한다. 선택하지 않으면 초안으로 남는다.

`beta` 릴리즈의 `latest.json`은 버전별 릴리즈의 MSI 주소를 가리킨다. 버전별 설치 파일은 유지하고, 새 베타 버전을 공개할 때 고정 채널의 JSON만 갱신한다. 공개 스크립트는 버전·MSI 존재 여부·서명을 확인하고 설치 파일을 먼저 공개한다. 공개 단계만 재시도할 때는 해당 버전의 소스를 체크아웃하고 `GITHUB_REPOSITORY=loopix8000/lof-writer` 환경 변수를 설정한 뒤 `node scripts/publish-release.mjs`를 실행한다.

정식 배포로 전환할 때는 업데이트 주소를 `https://github.com/loopix8000/lof-writer/releases/latest/download/latest.json`으로 변경한다. GitHub의 Latest에는 prerelease가 포함되지 않는다.

소스 저장소와 공개 배포 저장소를 분리할 경우에는 워크플로의 업로드 대상과 해당 저장소에 접근할 토큰도 함께 설정한다. 기본 워크플로의 대상은 실행 중인 저장소다.

## 로컬에서 서명된 MSI를 빌드할 때

위 공개키·업데이트 주소와 `TAURI_SIGNING_PRIVATE_KEY`를 환경 변수로 설정하고 다음 명령을 순서대로 실행한다.

```powershell
npm run updater:prepare
npm run tauri build -- --bundles msi --config src-tauri/tauri.updater.generated.json
```

생성된 설정 파일은 Git에서 제외된다. 비밀키는 이 파일에 기록하지 않는다. 업데이트 가능한 배포본을 만들 때는 반드시 이 설정을 포함해 빌드한다. 일반 `npm run build`는 프론트엔드 검사이며 MSI나 업데이트 파일을 만들지 않는다.

배포 전에는 이전 설치형 버전에서 새 버전으로 업데이트하고, 원고·메모·설정 보존과 저장 실패 시 설치 중단을 확인해야 한다. 현재 포터블 실행 파일에는 이 기능이 없으므로 첫 설치형 버전은 직접 설치해야 한다.
