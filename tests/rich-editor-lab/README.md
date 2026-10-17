# 긴 원고 입력 실험

실제 앱·배포본·설정·서재를 수정하지 않고, 최적화한 정적 번들을 별도 Headless Edge에서 실행한다. 제품의 편집기와 확장 코드는 그대로 가져오며 계측은 실험 번들에만 추가한다.

```powershell
node scripts/rich-editor-lab.mjs --fixture "D:/문서/큰 원고.md"
```

기본값은 이전 진단에서 만든 `.test-data/continuous-input/fixtures/카구야 오배송 1부.md` 사본이다. 입력 파일은 읽기만 한다. 실행 전후 SHA-256을 대조한다. 본문 30만 자 이상이 필요하고 원문 전용 문법이 포함되면 중단한다.

기본 실험은 같은 문서의 앞 10만·20만·30만 UTF-16 코드 단위를 사용한다. 한국어 BMP 글자는 한 단위다. 끝에서 `a`를 20ms 간격으로 60회(초당 50회) 입력하고 3회 반복한다. 예열 입력 1회는 제외한다. 반복마다 비교 순서를 뒤집는다. 실제 CDP 키 이벤트를 쓰며 한글 IME 조합 입력은 별도 대상이다.

| 비교군 | 의미 |
|---|---|
| writer | 실제 Writer 컴포넌트 + 작은 React 부모 |
| writer-no-cursor | 실제 Writer에서 부모 커서 줄 번호 통지만 제외한 기본 대조군 |
| writer-visibility | writer-no-cursor에 화면 밖 문단 배치 생략과 바깥 클릭 여유 64px를 적용한 실험군 |
| full | 같은 핵심 확장·Markdown 변환·문단 집계·React 본문 반영을 둔 작은 엔진 |
| no-serialize | full에서 전체 Markdown 문자열 생성만 제외. React 갱신은 유지 |
| no-react | full에서 입력 후 부모 React 갱신만 제외. Markdown 변환은 유지 |
| engine-only | 제품 확장은 유지하고 Markdown 변환·집계·입력 후 React 갱신을 모두 제외 |
| minimal | engine-only에서 제품 확장과 표·그림·Placeholder를 추가로 제외 |
| source | 실제 Writer의 CodeMirror 원문 편집 + 같은 작은 React 부모 |
| content-visibility | full에 문단별 content-visibility:auto를 적용한 선택 실험군. 제품 적용 아님 |
| visibility-engine | engine-only에 같은 화면 밖 배치 생략을 적용한 선택 실험군 |

`writer`가 전체 앱을 의미하지는 않는다. 자동 저장, Worker/Rust 집계, IPC, 사이드바, 검색 등은 재현하지 않는다. `full`과 비슷하게 재현되는지 먼저 확인한 뒤 제외 실험을 해석한다. `minimal`은 문서 스키마도 달라질 수 있어 확장 전체의 상한 비교로만 쓴다.

기본 비교는 `writer-no-cursor`를 사용한다. `writer`를 20만·30만 자에서 60회 연속 입력하면 실험 부모의 커서 줄 번호 상태 반영 경로에서 React #185 오류가 관찰됐다. 오류가 있는 비교군은 요약 수치에서 제외하고 실행도 실패 처리한다. 오류 스택은 `report.json`에 보존한다. 이 결과만으로 전체 앱에서 같은 오류가 발생한다고 단정하지 않는다.

실험 CSS는 `overflow-clip-margin:64px`로 문단 밖 북마크·메모 아이콘 영역을 보존한다. 단순 `content-visibility:auto`만 쓴 후보에서는 여백 아이콘 클릭 차단이 재현됐다. 이 여유를 둔 버전과 이전 단순 CSS 버전의 수치는 구분해야 한다. `report.json`의 `candidate`, `harnessSha256`에 실험 후보와 실행 소스 식별값을 남긴다.

제품의 일반 편집에도 같은 최적화가 적용됐다. 실험의 비최적화 비교군은 별도 CSS로 배치 생략을 해제해 기존 기준을 유지한다. 제품의 쪽 보기는 적용 대상에서 제외한다.

`--stability`를 주면 성능 측정이 끝난 같은 메모리 사본에서 커서·스크롤 좌표, 전체 선택·복사, 검색 이동, 입력·되돌리기·다시 실행, 여러 줄 붙여넣기, 한글 조합 이벤트, 북마크·메모 아이콘 클릭, 원문 모드 전환·복귀, 문서 재개방과 전체 본문 보존을 추가 검증한다. 현재 일반 편집 대상이며 source 비교군과 함께 쓸 수 없다. 조합 이벤트는 CDP 모의 검증이고 Windows 실제 IME 실사용 검증은 아니다. 디스크 자동 저장·복원도 포함하지 않는다.

측정 항목:

- 키 전송부터 브라우저 핸들러 시작까지의 대기 시간
- 키 전송부터 다음/다다음 requestAnimationFrame까지의 시간: 화면 갱신 기회의 대용 지표이며 실제 픽셀 표시 시점은 아님
- 호스트 입력 스케줄 지연과 두 시계의 동기화 오차 상한
- 트랜잭션 전체, 상태 적용, DOM 갱신, Markdown 변환, 문단 집계, 커서 줄 계산, 확장별 단계 시간
- 브라우저 배치·스타일 계산 합계, 긴 작업, DOM 요소 수
- 전체 본문과 기대 입력 결과 일치: 누락·중복·잘못된 위치 검사. 여러 입력이 한 트랜잭션에 합쳐질 수 있음

포함 시간끼리는 합산하지 않는다. p95는 개별 반복 내 입력별 값이며 최종 표는 세 반복의 p95 중앙값이다. `report.json`에는 원시 입력별 시각, 각 반복과 단계별 결과를 모두 보관한다.

```powershell
# 실제 Writer를 가져와 기존/후보의 입력 속도와 편집 동작을 함께 비교
node scripts/rich-editor-lab.mjs --modes writer-no-cursor,writer-visibility --stability --output .test-data/rich-editor-lab/stability

# CPU 프로파일: 계측 오버헤드가 추가되므로 기본 지연 결과와 구분
node scripts/rich-editor-lab.mjs --sizes 300000 --modes full,no-serialize,no-react,engine-only --repetitions 1 --profile --output .test-data/rich-editor-lab-profile
node scripts/summarize-input-profile.mjs .test-data/rich-editor-lab-profile

# 같은 30만 자를 약 3천 자 문단으로 묶어 DOM/문단 수와 글자 수를 구분
node scripts/rich-editor-lab.mjs --sizes 300000 --modes full,no-react,engine-only --layout long-paragraphs --output .test-data/rich-editor-lab-long-paragraphs

# 화면 밖 문단의 배치를 생략하는 CSS 실험. 선택·검색·스크롤 안정성 검증과 구분
node scripts/rich-editor-lab.mjs --sizes 300000 --modes full,content-visibility --output .test-data/rich-editor-lab-visibility

# 커서 위치 및 입력 속도 대조
node scripts/rich-editor-lab.mjs --sizes 300000 --modes writer,full,no-react --position start --interval 30 --output .test-data/rich-editor-lab-start

# 보고서 표만 다시 생성
node scripts/summarize-rich-editor-lab.mjs .test-data/rich-editor-lab
```

결과는 `--output`의 `report.md`, `report.json`과 선택적 CPU 프로파일에 저장한다. 테스트용 정적 서버는 임의의 로컬 포트를 쓰며 브라우저와 함께 종료한다. Vite 개발 서버와 Tauri 개발 앱은 실행하지 않는다.
