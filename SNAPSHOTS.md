# 데모 스냅샷 파이프라인

실제 Tauri 앱에서 소개용 화면을 구성하고 PNG를 촬영합니다. 「여름이 남긴 창가」 제목과 첫 예제 표지를 사용하고, 에피소드 본문은 소설이 아닌 퀵스타트 가이드 3편으로 구성합니다. 플롯·메모와 표는 짧은 기능 예제입니다. 회차 상태는 집필·수정·완료를 보여 주는 예시입니다.

각 에피소드는 공백 포함·줄바꿈 제외 기준으로 약 3,000자입니다. 앱에서 사용하는 계산 함수로 실제 본문 분량을 확인하며 표시 숫자를 따로 만들어 넣지 않습니다. 플롯·메모에는 분량 목표를 적용하지 않고 글자 수만 표시합니다.

새 에피소드와 데모 문서는 공통 기본값인 자동 관리를 따릅니다. 수동 관리를 강제로 지정하지 않으며, 문단 간격 등 조판 설정이 적용되는 상태로 촬영합니다.

표지는 제공된 PNG를 `assets/demo/cover.png`로 복사해 사용하며 원본 내용을 변경하지 않습니다. 저자 제공 원고를 사용하는 경우 소설 본문과 생성형 AI로 제작한 표지·소제목·데모용 보조 문구의 출처를 구분해 표시합니다. 별도 원고 설정이 없으면 AI로 만든 기본 예제를 사용합니다.

## 별도 원고 설정

기본값은 `scripts/snapshots/quickstart.mjs`의 가이드입니다. `--story 원고설정.json`을 명시했을 때만 별도 원고를 사용합니다. 원문 전체는 Git에서 제외되는 `.private/`에 둘 수 있으며, 공개 자료에는 실제로 촬영한 화면만 복사합니다.

개인 원고 설정 파일이 남아 있어도 자동으로 불러오지 않습니다. 가이드 촬영은 개인 소설의 본문이나 등장인물 정보를 읽지 않습니다.

원고 설정의 `chapters`에는 본문이 있는 3편을, `listOnlyChapters`에는 4~6편의 제목만, `specials`에는 에필로그 등 특별 회차의 제목과 `episodeType`만 지정합니다. `plot`, `note`, `quickNote`, `table`, `searchQuery`로 실제 작품에 맞는 데모용 보조 문구를 지정합니다. `attribution`과 `demoCaption`은 README와 소개 페이지에 함께 반영됩니다.

## 준비와 전체 촬영

Windows와 WebView2, 프로젝트 의존성 및 실행할 Tauri 앱이 필요합니다. Chromium을 별도로 설치하지 않고 앱의 WebView2에 연결합니다.

개발 실행파일과 프런트엔드를 준비합니다. 아래 명령은 개발 서버나 GUI를 실행하지 않습니다.

```powershell
npm run build
Push-Location src-tauri
cargo build
Pop-Location
```

아래 명령이 개발 실행파일용 정적 서버를 열고, 별도 데모 앱을 실행해 촬영한 다음 서버와 데모 앱을 종료합니다.

```powershell
node scripts/snapshot.mjs --exe src-tauri/target/debug/lof-writer.exe --serve-dist --update-readme --update-site
```

현재 작업 폴더의 개발 서버가 이미 `127.0.0.1:5173`에서 실행 중이면 `--serve-dist`를 빼고 실행합니다. 기존 서버는 파이프라인이 종료하지 않습니다. 다른 프로젝트가 해당 포트를 사용 중이면 먼저 해당 프로젝트와 겹치지 않게 실행 환경을 정리해야 합니다.

배포용 Tauri 실행파일을 지정하는 경우에는 `--exe "실행파일 경로"`를 사용하고 `--serve-dist`는 지정하지 않습니다. 파이프라인은 앱을 자동 빌드하거나 기존 배포본을 교체하지 않습니다. 실행파일은 촬영할 기능이 반영된 것이어야 합니다.

PowerShell의 npm 래퍼에 따라 옵션이 전달되지 않는 경우를 피하기 위해 예시는 `node` 직접 실행을 사용합니다. 동일 스크립트는 `npm.cmd run snapshot -- --list`처럼 실행할 수도 있습니다.

## 장면 선택과 커밋 범위

```powershell
# 촬영 목록만 조회한다. 앱을 실행하지 않는다.
node scripts/snapshot.mjs --list

# 지정한 커밋 이후 바뀐 파일과 연결된 촬영 장면을 조회한다.
node scripts/snapshot.mjs --plan --since HEAD~5

# 퀵 노트와 조판 화면만 밝게·어둡게 촬영한다.
node scripts/snapshot.mjs --exe src-tauri/target/debug/lof-writer.exe --serve-dist --scene quick-note,typesetting --theme both

# 지정 커밋 이후 영향을 받은 화면을 촬영한다.
node scripts/snapshot.mjs --exe src-tauri/target/debug/lof-writer.exe --serve-dist --since HEAD~5
```

`--since`는 과거 버전의 앱을 실행하는 기능이 아닙니다. 기준 커밋과 현재 HEAD의 변경 파일 및 기능 출처 커밋을 촬영 목록에 대조해 현재 앱에서 촬영할 화면을 고릅니다. 공통 화면 코드가 바뀌면 여러 장면을 함께 선택합니다. 화면 변화가 없는 동기화·저장 구조 등의 커밋은 스크린샷만으로 설명할 수 없으므로 별도 기능 설명이 필요합니다.

## 생성 결과

- `.snapshots/latest/`: 1440×960 PNG 15장, 미리보기 `index.html`, 실행 결과 `manifest.json`.
- `assets/screenshots/`: `--update-readme`로 갱신한 README용 대표 이미지 8장과 공개용 출처 기록.
- `.private/index.html`, `.private/assets/`: `--update-site`로 생성한 소개 사이트 파일. 기존 사이트의 색상과 다운로드·개인정보처리방침 링크를 유지합니다.
- 임시 폴더의 `lof-writer-demo-*`: 촬영용 설정·서재·WebView 프로필. 실제 작업 원고와 분리되며 촬영 후에도 데모 원고를 확인할 수 있도록 보존합니다. 경로는 촬영 로그와 내부 manifest에 표시합니다.

`--output 경로`로 내부 결과 위치를 바꾸거나 `--cover 표지.png`로 다른 PNG 표지를 지정할 수 있습니다. 기본 테마는 밝은 화면이며 `--theme dark` 또는 `--theme both`를 지원합니다.

## README와 사이트 재생성

기존 촬영 결과에서 파일 해시를 확인한 뒤 앱을 다시 실행하지 않고 소개 자료를 만들 수 있습니다.

```powershell
node scripts/snapshot.mjs --render-only --update-readme --update-site
```

소개 자료에는 `editor`, `project`, `quick-note`, `typesetting`, `bookmarks`, `split`, `mobile`, `table`의 밝은 화면이 모두 필요합니다. 실패했거나 파일 해시가 맞지 않는 결과는 게시용 이미지로 복사하지 않습니다. README는 `demo-snapshots` 표시 안의 소개 영역만 갱신합니다.

사이트 반영 시 `.private/index.html`과 `.private/assets/`를 사이트 저장소 루트에 복사합니다. 기존 `privacy.html`은 유지합니다. 이 명령은 파일만 생성하며 GitHub Pages에 게시하지 않습니다. `.private/`와 `.snapshots/`는 Git에서 제외됩니다.

## 장면 추가

`scripts/snapshots/scenes.mjs`에 장면을 추가합니다.

- `id`, `title`: 결과 파일 이름과 설명.
- `view`, `document`, `split`, `preferences`: 불러올 화면과 데모 문서, 화면 설정.
- `arrange(page, demo)`: 실제 화면에서 수행할 클릭·입력.
- `ready`: 촬영 전에 표시될 때까지 기다릴 요소.
- `commits`, `paths`: 기능 출처와 커밋 범위에 따른 촬영 선택 기준.

기본 가이드는 `quickstart.mjs`, 데이터 구성은 `demo.mjs`, 소개 페이지는 `site-template.html`에서 수정합니다. 별도 원고는 `.private/demo-story.json` 같은 설정 파일을 명시해 공급합니다. 촬영은 폰트·이미지 로딩과 화면 렌더링을 기다린 후 수행하고 실패한 장면을 별도로 기록합니다. 실행 결과에는 작업 소스 커밋과 미커밋 변경 여부, 실제 실행파일의 SHA-256, 앱 버전, 표지·이미지 해시, 에피소드별 실제 글자 수를 남깁니다. 실행파일이 해당 소스에서 빌드됐다는 사실을 커밋 값만으로 보증하지는 않습니다.

이 파이프라인은 소개 화면 촬영 도구입니다. 단위·통합·e2e 테스트 스위트를 실행하거나 기존 Electron 검증 스크립트를 호출하지 않습니다.
