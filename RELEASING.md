# PC·Android 릴리즈와 업데이트

Android APK는 별도 워크플로 **Build Android APK release**로 배포한다. 버전과 내부 버전 번호는 `src-tauri/tauri.android.conf.json`에서 관리하고, ARM64 APK는 기존 `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`로 서명한다. 앱은 APK의 해시·패키지·버전·서명을 확인한 뒤 원고를 저장하고 Android 설치 화면을 연다. 서명 키는 유지하고 `versionCode`를 매번 올린다. 릴리즈 노트는 `ANDROID_RELEASE_NOTES.md`, 아이콘 원본은 `src-tauri/android/app/src/main/res`에 있다.

공개 배포 저장소는 `loopix8000/lof-writer`이다. 설정 > 앱 업데이트에서 채널을 선택하며 기본값은 **정식**이다. 정식은 확정 버전만, RC는 정식·RC 중 최신 버전, 베타는 정식·RC·베타 중 최신 버전을 받는다. 채널을 바꿔도 이전 버전으로 내려가지 않는다.

| 선택 | PC 채널 태그 | Android 채널 태그 |
| --- | --- | --- |
| 정식 | `stable` | `android-stable` |
| RC | `rc` | `android-rc` |
| 베타 | `beta` | `android-beta` |

채널 주소는 `https://github.com/loopix8000/lof-writer/releases/download/<채널 태그>/latest.json`이다. 확정 정식은 세 채널에, `-rc.N`은 RC·베타 채널에, 그 밖의 시험 버전은 베타 채널에 배포 정보를 올린다. 이미 더 최신인 채널은 덮어쓰지 않는다. 구버전 Android의 `android-alpha` 주소도 유지한다. 기존 베타 앱은 기존 주소를 통해 RC로 업데이트할 수 있다.

RC도 GitHub에서는 prerelease로 게시한다. GitHub Latest는 PC 확정 정식만 사용하며, 앱 내 업데이트는 위 채널을 사용한다. 채널 릴리즈가 아직 없으면 업데이트 없음으로 처리한다. 기본 개발 설정에는 서명 공개키가 비어 있으므로 PC 업데이트는 배포 설정을 포함한 빌드에서 확인한다.

## 앱의 동작

- 시작 시 새 버전을 확인하는 설정과 수동 확인 버튼을 제공한다.
- 새 버전 안내에서 다운로드·설치를 직접 시작한다.
- 다운로드가 끝나면 편집과 단축키를 잠그고 원고·메모 저장이 완료될 때까지 기다린다.
- 저장 실패, 충돌, 진행 중인 작업이 있으면 설치를 중단하고 편집 화면으로 돌아간다.
- 서명을 검증한 설치 파일을 MSI 설치 프로그램으로 실행한다. Windows 앱은 종료되고 설치 완료 후 다시 실행된다.
- 개발자가 릴리즈 워크플로의 `show_update_notice`를 켠 버전은 업데이트 후 첫 실행에 한 번 완료 팝업을 표시한다. 알림을 누르면 해당 버전의 릴리즈 노트를 보여 준다.
- 설치 전 업데이트 안내도 대상 버전의 GitHub 릴리즈 본문을 보여 준다. 조회에 실패하면 다시 시도할 수 있다.
- 설정 > 앱 업데이트의 **버전별 릴리즈 노트**는 GitHub 릴리즈 목록(`v`로 시작하는 태그)을 불러와 보여 준다. 고정 채널 릴리즈(`beta`)와 초안은 제외한다.

## 서명 설정

PC·Android 릴리즈 모두 수동 실행 시 `show_update_notice`로 업데이트 완료 팝업을 지정할 수 있다. 기본값은 `false`이며, 팝업이 필요한 릴리즈에서만 실행할 때 켠다. 사용자 설정과는 별개다. 로컬 빌드에서 켜려면 빌드 전에 PowerShell에서 `$env:VITE_SHOW_UPDATE_NOTICE = 'true'`를 설정한다. 끄려면 해당 환경 변수를 제거하거나 `'false'`로 설정한다.

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

3. `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`의 버전을 함께 올리고 두 잠금 파일의 앱 버전도 맞춘다. 준비 스크립트는 버전이 다르면 빌드를 중단한다. MSI 내부 버전인 `bundle.windows.wix.version`은 앱 버전과 별도로 매 릴리즈마다 증가시킨다. 현재 앱 버전 `1.1.0`의 MSI 내부 버전은 `1.0.46`이다. [Windows Installer는 버전의 앞 세 자리만 비교](https://learn.microsoft.com/en-us/windows/win32/msi/productversion)하므로 네 번째 자리만 올리면 업그레이드를 구분할 수 없다. 기존 MSI의 UpgradeCode는 유지한다.
4. GitHub Actions의 **Build Windows MSI release**를 `main`에서 수동 실행한다. **Publish the release and matching update channels after building**을 선택하면 MSI·서명·`latest.json`을 업로드한 뒤 공개하고 버전에 맞는 업데이트 채널을 갱신한다. 선택하지 않으면 초안으로 남는다.

채널의 `latest.json`은 버전별 릴리즈의 설치 파일을 가리킨다. 버전별 설치 파일은 유지하고 채널의 JSON만 갱신한다. PC 공개 스크립트는 버전·MSI 존재 여부·서명을 확인하고 설치 파일을 먼저 공개한다. 공개 단계만 재시도할 때는 해당 버전의 소스를 체크아웃하고 `GITHUB_REPOSITORY=loopix8000/lof-writer` 환경 변수를 설정한 뒤 `node scripts/publish-release.mjs`를 실행한다.

PC·Android 업데이트 주소는 플랫폼별 고정 채널을 유지한다. GitHub의 Latest에는 prerelease가 포함되지 않으므로 RC 업데이트 주소로 사용하지 않는다.

소스 저장소와 공개 배포 저장소를 분리할 경우에는 워크플로의 업로드 대상과 해당 저장소에 접근할 토큰도 함께 설정한다. 기본 워크플로의 대상은 실행 중인 저장소다.

## 로컬에서 서명된 MSI를 빌드할 때

위 공개키·업데이트 주소와 `TAURI_SIGNING_PRIVATE_KEY`를 환경 변수로 설정하고 다음 명령을 순서대로 실행한다.

```powershell
npm run updater:prepare
npm run tauri build -- --bundles msi --config src-tauri/tauri.updater.generated.json
```

생성된 설정 파일은 Git에서 제외된다. 비밀키는 이 파일에 기록하지 않는다. 업데이트 가능한 배포본을 만들 때는 반드시 이 설정을 포함해 빌드한다. 일반 `npm run build`는 프론트엔드 검사이며 MSI나 업데이트 파일을 만들지 않는다.

배포 전에는 이전 설치형 버전에서 새 버전으로 업데이트하고, 원고·메모·설정 보존과 저장 실패 시 설치 중단을 확인해야 한다. 현재 포터블 실행 파일에는 이 기능이 없으므로 첫 설치형 버전은 직접 설치해야 한다.
