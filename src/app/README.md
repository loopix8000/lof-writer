# 앱 구성

`../App.tsx`는 앱 상태, 저장 순서, 문서 이동, 편집기 그룹을 조율한다.

| 역할 | 모듈 |
| --- | --- |
| 서재·작품 화면 | `LibraryPage`, `ProjectPage`, `ProjectForm` |
| 파일 트리 | `FileTree`, `MemoFolderTree`, `EpisodeDocList`, `BrokenFiles` |
| 북마크·연결 문서 | `BookmarksPage`, `BookmarkList`, `DocumentLinksWidget` |
| 설정 | `SettingsContent`, `AutocompleteSettings`, `TypesettingSettings`, `settings-pages` |
| 창 제어 | `TitleBar`, `LayoutIcon` |
| 설정 저장 | `usePreferences` |
| 문서 이미지·연결 메모 | `useDocumentImages`, `useDocumentNotes` |
| 문서 캐시·탭·이동 타입 | `model` |
| 문서 유형의 이름·아이콘 | `document-ui` |

화면 컴포넌트는 필요한 값과 동작을 props로 받는다. 파일 트리의 하위 목록은 슬롯으로 전달해 목록별 의존성이 트리 전체로 퍼지지 않게 한다.

저장 대기열, 편집 중인 원고, 열린 탭의 본문·스크롤은 `App`이 관리한다. 편집기 주변 코드를 분리할 때는 `RetainedTab`의 key와 문서 전환 시 저장·읽기 순서를 유지한다. 설정 입력 중인 대치어도 `App`에 두어 설정 창을 닫았다 열어도 남긴다.
