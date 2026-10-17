// 커밋은 기능의 출처, paths는 --since 실행 시 다시 촬영할 파일 범위다.
const appPaths = ["src/App.tsx", "src/style.css", "src-tauri/src/store.rs"];
const writerPaths = [...appPaths, "src/Writer.tsx", "src/typing-extension.ts"];
const button = (page, name) => page.getByRole("button", { name, exact: true });
const manuscript = page => page.getByTestId("manuscript");

async function selectOpening(page) {
  await manuscript(page).locator("p").first().click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+ArrowDown");
}

export const scenes = [
  { id: "library", title: "작품 서재", view: "library", ready: ".project-grid .project-card", paths: appPaths },
  { id: "project", title: "회차와 집필 상태", view: "project", ready: ".project-hero", paths: [...appPaths, "src-tauri/src/episode.rs"] },
  { id: "editor", title: "집필 화면과 연결 문서 위젯", ready: '[data-testid="manuscript"] .noted',
    commits: ["7928311", "92d917c", "94b5479", "cc35060"], paths: writerPaths },
  { id: "quick-note", title: "선택한 문장에서 퀵 노트 작성", ready: ".quick-note",
    commits: ["b2c3949", "b9b3a8c"], paths: [...writerPaths, "src/QuickNote.tsx"],
    async arrange(page, demo) {
      await selectOpening(page);
      await manuscript(page).locator("p").first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "메모 추가", exact: true }).click();
      await page.getByRole("textbox", { name: "제목", exact: true }).fill(demo.quickNote?.title || "첫 장면과 마지막 장면의 연결");
      await page.getByRole("textbox", { name: "메모", exact: true }).fill(demo.quickNote?.body || "오후 네 시의 빛을 마지막 회차에서도 반복하기. 혼자 머무는 자리에서 함께 기다리는 자리로 의미가 달라지도록 구성한다.");
    } },
  { id: "note-source", title: "퀵 노트의 원고 출처 링크", document: "note", ready: '[data-testid="manuscript"] a[href^="lof:"]',
    commits: ["cc35060"], paths: [...writerPaths, "src/note-links.ts", "src/QuickNote.tsx"] },
  { id: "bookmarks", title: "모든 작품의 북마크 모아 보기", view: "bookmarks", ready: ".bookmarks-page .bookmark-item",
    commits: ["0f65aac", "26211aa"], paths: [...writerPaths, "src/bookmark-extension.ts"] },
  { id: "context-menu", title: "원고 우클릭 메뉴와 이미지 삽입", ready: ".context-menu",
    commits: ["97a90ab"], paths: [...writerPaths, "src/ContextMenu.tsx", "src/image-extension.ts"],
    async arrange(page) {
      await selectOpening(page);
      await manuscript(page).locator("p").first().click({ button: "right" });
    } },
  { id: "document-tree", title: "회차에 연결된 플롯과 메모", ready: ".file-sidebar .tree-tabs",
    commits: ["ba3f87e", "7928311", "e435c80"], paths: appPaths,
    async arrange(page, demo) {
      await page.getByRole("tablist", { name: "파일 트리 보기" }).getByRole("tab", { name: /^문서/ }).click();
      await page.locator(".file-sidebar").getByText(demo.plot.title, { exact: true }).waitFor();
    } },
  { id: "split", title: "원고와 플롯을 나란히 집필", split: true, ready: '[data-testid="manuscript-readonly"]', paths: writerPaths,
    async arrange(page) { await button(page, "위젯 보드 표시/숨기기").click(); } },
  { id: "mobile", title: "모바일 화면으로 원고 미리보기", ready: ".mobile-preview .phone", paths: [...writerPaths, "src/MobilePreview.tsx"],
    async arrange(page) {
      await button(page, "위젯 보드 표시/숨기기").click();
      await button(page, "모바일 미리보기").click();
    } },
  { id: "search", title: "한글 원고 본문 검색", ready: ".search-hit", paths: [...appPaths, "src/SearchViews.tsx", "src-tauri/src/text.rs"],
    commits: ["325e9dd"],
    async arrange(page, demo) {
      await page.keyboard.press("Control+Shift+f");
      await page.getByRole("textbox", { name: "검색어", exact: true }).fill(demo.searchQuery);
    } },
  { id: "table", title: "표와 문서 속성", document: "table", preferences: { episodeInfoOpen: true },
    ready: '[data-testid="manuscript"] table', paths: [...writerPaths, "src/table-extension.ts", "src/EpisodeProperties.tsx", "src/CustomProperties.tsx"] },
  { id: "focus", title: "집중 모드", ready: ".app.focus-mode", paths: writerPaths,
    async arrange(page) { await button(page, "집중 모드").click(); } },
  { id: "settings", title: "자동 완성과 입력 편의 설정", ready: '.settings-content', paths: [...appPaths, "core/typing.mjs"],
    async arrange(page) {
      await button(page, "설정").click();
      await button(page, "자동 완성").click();
    } },
];
