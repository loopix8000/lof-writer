# 앱 구성

`../App.tsx`는 앱 상태, 저장 순서, 문서 이동을 관리하고 화면과 편집기 그룹을 연결한다.

| 역할 | 모듈 |
| --- | --- |
| 서재·작품 화면 | `LibraryPage`, `ProjectPage`, `ProjectForm` |
| 파일 트리 | `FileTree`, `MemoFolderTree`, `EpisodeDocList`, `BrokenFiles` |
| 북마크·연결 문서 | `BookmarksPage`, `BookmarkList`, `DocumentLinksWidget` |
| 설정 | `SettingsContent`, `AutocompleteSettings`, `TypesettingSettings`, `settings-pages` |
| 창 제어 | `TitleBar`, `LayoutIcon` |
| 편집기 탭·분할 그룹 | `useEditorGroups` |
| 설정 저장 | `usePreferences` |
| 문서 이미지·연결 메모 | `useDocumentImages`, `useDocumentNotes` |
| 문서 캐시·탭·이동 타입 | `model` |
| 문서 유형의 이름·아이콘 | `document-ui` |

화면 컴포넌트는 필요한 값과 동작을 props로 받는다. 파일 트리의 하위 목록은 슬롯으로 전달해 목록별 의존성이 트리 전체로 퍼지지 않게 한다.

저장 대기열, 편집 중인 원고와 문서별 스크롤은 `App`이 관리한다. 탭 목록·고정·닫기·재정렬, 그룹 분할·전환·크기 조절, 열린 탭의 본문 보관과 비활성 그룹의 외부 변경 확인은 `useEditorGroups`가 관리한다. `App`은 탭이나 그룹의 내부 상태를 변경하지 않고 훅의 동작을 호출한다.

그룹을 전환할 때는 `App`의 문서 이동 함수가 저장과 읽기를 마친 뒤 `beforeCommit`을 호출한다. 훅은 이 시점에 그룹을 맞바꿔 편집 문서 변경과 같은 렌더에 반영한다. 마지막 탭을 닫을 때 다른 문서 이동이 시작되면 닫기를 취소한다. 편집기 주변 코드를 변경할 때는 이 순서와 `RetainedTab`의 key를 유지한다.

설정 입력 중인 대치어도 `App`에 두어 설정 창을 닫았다 열어도 남긴다.
