import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";

// 실제 Tauri WebView2와 Rust 저장소를 사용한다. 테스트 서재와 프로필은 기존 사용자 데이터와 분리한다.
// 먼저 npm run build를 실행한다. 개발 실행 파일에는 devUrl에서 정적 dist를 제공한다.
// LOF_TEST_REUSE_DEV_SERVER=1이면 기존 Vite 서버의 소스 일치를 확인하고 사용한다.
const root = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(process.env.LOF_TEST_EXECUTABLE || path.join(root, "src-tauri/target/debug/lof-writer.exe"));
const frontend = path.join(root, "dist");
await fs.mkdir(path.join(root, ".test-data"), { recursive: true });
const data = await fs.mkdtemp(path.join(root, ".test-data", "tauri-refactor-"));
const vault = path.join(data, "vault"), profile = path.join(data, "profile");
await fs.mkdir(profile);
await fs.writeFile(path.join(profile, "settings.json"), JSON.stringify({ preferences: {
  setupComplete: true, checkUpdatesOnStartup: false, textReplacementsVersion: 1,
}, connections: [] }));
const hashFile = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const report = { passed: false, data, executable, checks: [], failedChecks: [], pageErrors: [], nativeErrors: [], cleanup: {} };
report.executableSha256 = await hashFile(executable);
report.source = Object.fromEntries(await Promise.all([
  "src/App.tsx", "src/app/useEditorGroups.ts", "src/app/useFileTree.ts", "src/app/useDocumentSession.ts",
].map(async file => [file, await hashFile(path.join(root, file))])));
let child, browser, page, server, launchError;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function appCall(method, args = {}) {
  return page.evaluate(async ({ method, args }) => {
    const result = await window.lof[method](args);
    if (!result.ok) throw Object.assign(Error(`${method}: ${result.error}`), { code: result.code });
    return result.data;
  }, { method, args });
}
async function check(label, action, recover) {
  report.currentCheck = label;
  try {
    await action();
    report.checks.push(label);
    console.log(`PASS ${label}`);
  } catch (error) {
    const file = `failure-${report.failedChecks.length + 1}.png`;
    report.failedChecks.push({ label, error: error.stack || String(error), screenshot: file,
      screen: await page.locator("body").innerText({ timeout: 3000 }).catch(() => "") });
    await page.screenshot({ path: path.join(data, file), timeout: 5000 }).catch(() => {});
    console.error(`FAIL ${label}: ${error.message.split("\n")[0]}`);
    if (!recover) throw error;
    await recover();
  }
  await fs.writeFile(path.join(data, "report.json"), JSON.stringify(report, null, 2));
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

try {
  server = http.createServer(async (req, res) => {
    const relative = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(frontend, relative);
    if (!file.startsWith(frontend + path.sep)) { res.writeHead(403).end(); return; }
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(file)] || "application/octet-stream";
    try { res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" }); res.end(await fs.readFile(file)); }
    catch { res.end(); }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(5173, "127.0.0.1", resolve); });
    report.frontendMode = "static-dist";
  } catch (error) {
    if (error.code !== "EADDRINUSE" || process.env.LOF_TEST_REUSE_DEV_SERVER !== "1") throw error;
    server = undefined;
    report.frontendMode = "existing-vite";
    for (const file of [...Object.keys(report.source), "src/main.tsx", "src/tauri-bridge.ts"]) {
      const served = await (await fetch(`http://127.0.0.1:5173/${file}`, { signal: AbortSignal.timeout(5000) })).text();
      const encoded = served.match(/sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/)?.[1];
      if (!encoded) throw Error(`기존 서버의 원본 소스 확인 실패: ${file}`);
      const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const local = (await fs.readFile(path.join(root, file), "utf8")).replaceAll("\r\n", "\n");
      expect(map.sourcesContent.some(content => content.replaceAll("\r\n", "\n") === local), file).toBe(true);
    }
    console.log("기존 Vite 서버의 현재 소스 일치 확인 완료");
  }
  const port = await freePort();
  child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: true, stdio: "ignore", env: {
    ...process.env, LOF_USER_DATA: profile, LOF_VAULT: vault,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  } });
  child.once("error", error => { launchError = error; });
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error(`Tauri 앱 종료: ${child.exitCode}`);
    try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, { timeout: 30000 }).toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages().find(item => !item.url().startsWith("devtools:"));
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => !!window.lof?.bootstrap);
  const runtime = JSON.parse(await fs.readFile(path.join(profile, "runtime.json"), "utf8"));
  expect(runtime.pid).toBe(child.pid);
  const initial = await appCall("bootstrap");
  expect(path.resolve(initial.root).toLowerCase()).toBe(vault.toLowerCase());
  expect(initial.projects).toHaveLength(0);
  expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:5173/);
  report.appVersion = initial.version;
  report.pid = child.pid;
  report.webView = await page.evaluate(() => navigator.userAgent);
  await page.addInitScript(version => localStorage.setItem("lof.releaseNotesSeenVersion", version), initial.version);
  const project = await appCall("createProject", { title: "모듈화 통합 확인" });
  const docs = [];
  for (let index = 1; index <= 23; index++) docs.push(await appCall("createDocument", {
    projectId: project.id, kind: "episode", title: `확인 원고 ${String(index).padStart(2, "0")}`, body: `원고 ${index}의 처음 본문`,
  }));
  const memo = await appCall("createDocument", { projectId: project.id, kind: "memo", title: "자료 메모", body: "메모 처음 본문" });
  await appCall("createDocument", { projectId: project.id, kind: "plot", title: "연결 플롯", body: "플롯 본문", episodeId: docs[0].id });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app").first().waitFor();
  const main = page.locator(".content-shell");
  const focused = () => main.locator(".editor-group.focused, .editor-groups:not(.split) > .editor-group");
  const title = () => focused().getByRole("textbox", { name: "문서 제목", exact: true }).filter({ visible: true });
  const writer = () => focused().getByTestId("manuscript").filter({ visible: true });
  const tabs = () => main.locator(".editor-groups .editor-tabs .editor-tab");
  const tree = id => page.locator(`.file-tree [data-doc-id="${id}"]`);
  const folder = name => page.locator(".file-tree .memo-folder").filter({ has: page.locator(`:scope > span`).filter({ hasText: name }) });
  const episodeTab = () => page.getByRole("tab", { name: /^에피소드/ });
  const memoTab = () => page.getByRole("tab", { name: /^문서/ });
  const status = () => focused().locator(".save-indicator").filter({ visible: true });
  const conflict = () => focused().locator(".conflict-banner").filter({ visible: true });
  const save = async () => { await page.keyboard.press("Control+s"); await expect(status()).toHaveText("저장됨"); };
  const read = id => appCall("readDocument", { id });
  const library = () => appCall("bootstrap");
  const currentMeta = async name => (await library()).documents.find(doc => doc.title === name);
  const clearError = async () => { const button = page.getByRole("button", { name: "오류 닫기", exact: true }); if (await button.isVisible()) await button.click(); };
  const open = async doc => {
    if (doc.kind === "episode") await episodeTab().click(); else await memoTab().click();
    if (!(await tree(doc.id).isVisible()) && doc.kind === "episode") {
      for (const group of await page.locator('.file-tree .episode-group[aria-expanded="false"]').all()) await group.click();
    }
    await tree(doc.id).click();
    await expect(title()).toHaveValue(doc.title);
  };
  const resetTo = async doc => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.lof?.bootstrap);
    await page.locator(".project-card").filter({ hasText: project.title }).waitFor();
    await page.keyboard.press("Control+p");
    await page.getByRole("textbox", { name: "파일 이름", exact: true }).fill(doc.title);
    await page.getByRole("option").filter({ has: page.getByText(doc.title, { exact: true }) }).click();
    await expect(title()).toHaveValue(doc.title);
  };
  await page.locator(".project-card").filter({ hasText: project.title }).click();
  await page.locator(".episode-row").filter({ hasText: docs[0].title }).click();
  await expect(title()).toHaveValue(docs[0].title);
  report.loadedScripts = await page.evaluate(() => [...document.scripts].map(script => script.src));
  await page.evaluate(() => {
    window.__nativeTestTrace = [];
    for (const name of ["saveDocument", "saveDraft", "clearDraft", "memoMove", "memoRename", "reorderDocuments", "restore", "checkpointDocument"]) {
      const original = window.lof[name];
      window.lof[name] = async args => {
        const result = await original(args);
        window.__nativeTestTrace.push({ name, id: args?.id, path: args?.path, ok: result.ok, code: result.code });
        return result;
      };
    }
  });

  await check("1. 미리보기 재사용·고정·편집 시 자동 고정", async () => {
    await open(docs[1]);
    await expect(tabs()).toHaveCount(1);
    await expect(tabs()).toHaveClass(/preview/);
    await tabs().dblclick();
    await expect(tabs()).not.toHaveClass(/preview/);
    await open(docs[0]);
    await writer().fill("전환 전 작성한 한글 원고");
    await expect(tabs().filter({ hasText: docs[0].title })).not.toHaveClass(/preview/);
  });
  await check("1. 탭 전환 전 실제 원고 파일 저장", async () => {
    await tabs().filter({ hasText: docs[1].title }).click();
    await expect(title()).toHaveValue(docs[1].title);
    await expect.poll(async () => (await read(docs[0].id)).body).toContain("전환 전 작성한 한글 원고");
    expect(await fs.readFile((await read(docs[0].id)).path, "utf8")).toContain("전환 전 작성한 한글 원고");
  });
  await check("1. 그룹 분할·양쪽 포커스·본문 보존·크기 조절", async () => {
    await page.keyboard.press("Control+Backslash");
    await expect(main.locator(".editor-groups.split > .editor-group")).toHaveCount(2);
    await expect(focused()).toHaveAttribute("data-split-group", "right");
    await page.keyboard.press("Control+1");
    await expect(title()).toHaveValue(docs[0].title);
    await expect(writer()).toContainText("전환 전 작성한 한글 원고");
    const sash = main.locator(".group-sash"), before = await sash.boundingBox();
    const groups = await main.locator(".editor-groups").boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down(); await page.mouse.move(groups.x + groups.width * 0.62, before.y + before.height / 2); await page.mouse.up();
    expect(Math.abs((await sash.boundingBox()).x - before.x)).toBeGreaterThan(20);
    await sash.dblclick();
    await page.keyboard.press("Control+2");
    await expect(title()).toHaveValue(docs[1].title);
    await page.screenshot({ path: path.join(data, "01-split.png") });
  });
  await check("1. 그룹 마지막 탭·전체 마지막 탭 닫기·재열기", async () => {
    await page.keyboard.press("Control+w");
    await expect(main.locator(".editor-groups > .editor-group")).toHaveCount(1);
    await expect(title()).toHaveValue(docs[0].title);
    await page.keyboard.press("Control+w");
    await expect(page.locator(".workspace-empty")).toBeVisible();
    await expect(page.locator(".file-tree")).toBeVisible();
    await open(docs[2]);
  });
  await check("1. 탭 드래그 재정렬·순환 단축키", async () => {
    await tree(docs[2].id).dblclick();
    await open(docs[0]); await tree(docs[0].id).dblclick();
    await tabs().filter({ hasText: docs[0].title }).dragTo(tabs().filter({ hasText: docs[2].title }));
    await expect(tabs().first()).toContainText(docs[0].title);
    await page.keyboard.press("Control+Tab"); await expect(title()).toHaveValue(docs[2].title);
    await page.keyboard.press("Control+Shift+Tab"); await expect(title()).toHaveValue(docs[0].title);
  });

  await check("2. 회차 묶음 펼침·접힘 및 검색 Enter·Escape", async () => {
    const group = page.locator(".file-tree .episode-group").first();
    await group.click(); await expect(tree(docs[0].id)).toHaveCount(0);
    await group.click(); await expect(tree(docs[0].id)).toBeVisible();
    const search = page.getByRole("textbox", { name: "에피소드 검색", exact: true });
    await search.fill(docs[22].title);
    await expect(page.locator('.file-tree .tree-panel:not([hidden]) [data-doc-id]')).toHaveCount(1);
    await search.press("Enter"); await expect(title()).toHaveValue(docs[22].title);
    await search.press("Escape"); await expect(search).toHaveValue("");
    await expect(tree(docs[22].id)).toBeVisible();
  });
  await check("2. Shift 범위 선택·Ctrl 선택·Escape 해제", async () => {
    await open(docs[0]);
    await tree(docs[2].id).click({ modifiers: ["Shift"] });
    await expect(page.locator(".file-tree .multi-selected")).toHaveCount(3);
    await tree(docs[1].id).click({ modifiers: ["Control"] });
    await expect(page.locator(".file-tree .multi-selected")).toHaveCount(2);
    await tree(docs[2].id).press("Escape");
    await expect(page.locator(".file-tree .multi-selected")).toHaveCount(0);
  });
  await check("2. F2 이름 변경 저장·Escape 취소", async () => {
    await tree(docs[0].id).press("F2");
    await page.getByRole("textbox", { name: "새 이름", exact: true }).fill("이름 변경 확인 원고");
    await page.getByRole("textbox", { name: "새 이름", exact: true }).press("Enter");
    await expect(title()).toHaveValue("이름 변경 확인 원고");
    await expect.poll(async () => (await read(docs[0].id)).title).toBe("이름 변경 확인 원고");
    docs[0].title = "이름 변경 확인 원고";
    await tree(docs[0].id).press("F2");
    await page.getByRole("textbox", { name: "새 이름", exact: true }).fill("취소할 이름");
    await page.getByRole("textbox", { name: "새 이름", exact: true }).press("Escape");
    expect((await read(docs[0].id)).title).toBe(docs[0].title);
  });
  await check("2. 회차 드래그 순서 변경·현재 원고 경로 갱신", async () => {
    await tree(docs[0].id).dragTo(tree(docs[2].id), { targetPosition: { x: 40, y: 25 } });
    await expect.poll(async () => (await library()).documents.filter(doc => doc.kind === "episode").slice(0, 3).map(doc => doc.id)).toEqual([docs[1].id, docs[2].id, docs[0].id]);
    await writer().fill("회차 순서 변경 뒤 저장한 본문"); await save();
    expect(await fs.readFile((await read(docs[0].id)).path, "utf8")).toContain("회차 순서 변경 뒤 저장한 본문");
  }, async () => {
    // 앞 항목의 실패를 기록한 뒤 명시적으로 새 내용을 읽어 독립적인 나머지 항목을 진행한다.
    if (await conflict().isVisible()) await focused().getByRole("button", { name: "바뀐 내용 불러오기", exact: true }).filter({ visible: true }).click();
    await expect(conflict()).toHaveCount(0);
    await clearError();
  });
  await check("2. 다중 선택 보관·보관 해제", async () => {
    await tree(docs[3].id).click();
    await expect(title()).toHaveValue(docs[3].title);
    await tree(docs[4].id).click({ modifiers: ["Shift"] });
    await expect(page.locator(".file-tree .multi-selected")).toHaveCount(2);
    await tree(docs[3].id).press("Delete");
    await expect.poll(async () => (await library()).documents.filter(doc => [docs[3].id, docs[4].id].includes(doc.id) && doc.archived).length).toBe(2);
    await page.getByRole("button", { name: "보관함 보기", exact: true }).click();
    await expect(tree(docs[3].id)).toBeVisible();
    await tree(docs[3].id).click();
    await expect(title()).toHaveValue(docs[3].title);
    await tree(docs[4].id).click({ modifiers: ["Shift"] });
    await expect(page.locator(".file-tree .multi-selected")).toHaveCount(2);
    await tree(docs[3].id).click({ button: "right" });
    await page.getByRole("menuitem", { name: "보관 해제", exact: true }).click();
    await expect.poll(async () => (await library()).documents.filter(doc => [docs[3].id, docs[4].id].includes(doc.id) && doc.archived).length).toBe(0);
    await page.getByRole("button", { name: "현재 문서 보기", exact: true }).click();
    if (await conflict().isVisible()) await focused().getByRole("button", { name: "바뀐 내용 불러오기", exact: true }).filter({ visible: true }).click();
    await open(docs[0]);
    if (await conflict().isVisible()) await focused().getByRole("button", { name: "바뀐 내용 불러오기", exact: true }).filter({ visible: true }).click();
  }, async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.lof?.bootstrap);
    for (const doc of docs.slice(3, 5)) {
      const latest = await read(doc.id);
      if (latest.archived) await appCall("saveDocument", { id: doc.id, archived: false, expectedRevision: latest.revision });
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".project-card").filter({ hasText: project.title }).click();
    await page.locator(".episode-row").filter({ hasText: docs[0].title }).click();
    await expect(title()).toHaveValue(docs[0].title);
  });
  await check("2. 전체 문서·현재 회차 범위·문서 검색", async () => {
    await memoTab().click();
    await page.getByRole("radio", { name: "현재 회차만", exact: true }).click();
    await expect(page.locator(".episode-doc-caption")).toContainText(docs[0].title);
    await expect(page.locator('.file-tree .tree-panel:not([hidden]) [data-doc-id]')).toHaveCount(1);
    await expect(page.locator('.file-tree .tree-panel:not([hidden])')).toContainText("연결 플롯");
    await page.getByRole("radio", { name: "전체 문서", exact: true }).click();
    const search = page.getByRole("textbox", { name: "문서 검색", exact: true });
    await search.fill("자료 메모");
    await expect(page.locator('.file-tree .tree-panel:not([hidden]) [data-doc-id]')).toHaveCount(1);
    await search.press("Escape");
    await expect(page.locator('.file-tree .tree-panel:not([hidden]) [data-doc-id]')).toHaveCount(2);
  });
  await check("2. 폴더 생성·펼침·접힘·문서 드래그 이동", async () => {
    await page.getByRole("button", { name: "폴더 추가", exact: true }).click();
    const rename = page.getByRole("textbox", { name: "새 폴더 이름", exact: true });
    await rename.fill("인물 자료"); await rename.press("Enter");
    await expect(folder("인물 자료")).toBeVisible();
    await open(memo);
    await writer().fill("폴더 이동 전 저장할 메모");
    await tree(memo.id).dragTo(folder("인물 자료"));
    await expect.poll(async () => (await currentMeta("자료 메모"))?.relPath).toContain("doc/인물 자료/");
    Object.assign(memo, await currentMeta("자료 메모"));
    await expect(tree(memo.id)).toBeVisible();
    await folder("인물 자료").click(); await expect(tree(memo.id)).toHaveCount(0);
    await folder("인물 자료").click(); await expect(tree(memo.id)).toBeVisible();
    await expect(title()).toHaveValue(memo.title);
    expect((await read(memo.id)).body).toContain("폴더 이동 전 저장할 메모");
  });
  await check("2. 열린 문서가 든 폴더 이름 변경·경로·탭 연결", async () => {
    await folder("인물 자료").press("F2");
    const rename = page.getByRole("textbox", { name: "새 폴더 이름", exact: true });
    await rename.fill("등장인물"); await rename.press("Enter");
    await expect.poll(async () => (await currentMeta("자료 메모"))?.relPath).toContain("doc/등장인물/");
    Object.assign(memo, await currentMeta("자료 메모"));
    await expect(tree(memo.id)).toBeVisible();
    await writer().fill("폴더 이름 변경 뒤 저장한 메모"); await save();
    expect(await fs.readFile((await read(memo.id)).path, "utf8")).toContain("폴더 이름 변경 뒤 저장한 메모");
    await expect(tabs().filter({ hasText: memo.title })).toHaveCount(1);
    await page.screenshot({ path: path.join(data, "02-folders.png") });
  }, () => resetTo(docs[0]));
  await check("2. 드래그 중 트리 탭 전환·회차 연결·유형 묶음 접기", async () => {
    await memoTab().click();
    if (!(await tree(memo.id).isVisible())) await folder("등장인물").click();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await tree(memo.id).dispatchEvent("dragstart", { dataTransfer: transfer });
    await episodeTab().dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(episodeTab()).toHaveAttribute("aria-selected", "true");
    await tree(docs[0].id).dispatchEvent("dragover", { dataTransfer: transfer });
    await tree(docs[0].id).dispatchEvent("drop", { dataTransfer: transfer });
    await expect.poll(async () => (await read(memo.id)).episodeId).toBe(docs[0].id);
    await memoTab().click();
    await page.getByRole("radio", { name: "현재 회차만", exact: true }).click();
    await expect(tree(memo.id)).toBeVisible();
    const group = page.locator(".file-tree .doc-group").filter({ hasText: "메모" });
    await group.click(); await expect(tree(memo.id)).toHaveCount(0);
    await group.click(); await expect(tree(memo.id)).toBeVisible();
    await page.getByRole("radio", { name: "전체 문서", exact: true }).click();
    await transfer.dispose();
  });

  await resetTo(docs[0]);
  await check("3. 한글 본문 자동 저장·임시본 정리", async () => {
    await open(docs[0]);
    await writer().fill("자동 저장으로 남길 한글 본문");
    await expect.poll(async () => (await read(docs[0].id)).body).toContain("자동 저장으로 남길 한글 본문");
    await expect(status()).toHaveText("저장됨");
    await expect.poll(async () => (await library()).drafts.some(draft => draft.id === docs[0].id)).toBe(false);
  });
  await check("3. WebView2 IME 조합 중 저장·전환 차단 및 종료 후 저장", async () => {
    await writer().fill("조합 보호 "); await save();
    await writer().click(); await page.keyboard.press("Control+End");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "하", selectionStart: 1, selectionEnd: 1 });
    await tree(docs[1].id).dispatchEvent("click");
    await expect(page.locator(".error-banner")).toContainText("한글 입력 조합");
    await expect(title()).toHaveValue(docs[0].title);
    expect((await read(docs[0].id)).body).not.toContain("하");
    await cdp.send("Input.insertText", { text: "한" });
    await expect.poll(async () => (await read(docs[0].id)).body).toContain("한");
    await clearError(); await open(docs[1]);
    await cdp.detach();
  });
  await check("3. 빠른 연속 편집·수동 저장 후 파일과 최종 본문 일치", async () => {
    for (const text of ["빠른 편집 하나", "빠른 편집 둘", "빠른 편집 최종"]) await writer().fill(text);
    await save();
    expect((await read(docs[1].id)).body).toContain("빠른 편집 최종");
    expect(await fs.readFile((await read(docs[1].id)).path, "utf8")).toContain("빠른 편집 최종");
  });
  await check("3. 뒤로·앞으로 이동 시 저장·원고 복귀", async () => {
    await open(docs[2]);
    await writer().fill("이동 기록에서 복귀할 원고");
    await open(docs[0]);
    await page.getByRole("button", { name: "뒤로가기", exact: true }).click();
    await expect(title()).toHaveValue(docs[2].title);
    await expect(writer()).toContainText("이동 기록에서 복귀할 원고");
    await page.getByRole("button", { name: "앞으로가기", exact: true }).click();
    await expect(title()).toHaveValue(docs[0].title);
  });
  await check("3. 실제 파일 외부 변경 감지·현재 본문 보존·명시적 불러오기", async () => {
    const doc = await read(docs[0].id);
    await fs.writeFile(doc.path, (await fs.readFile(doc.path, "utf8")).replace(doc.body, "외부에서 수정한 새 본문\n"));
    await expect(conflict()).toBeVisible({ timeout: 20000 });
    await expect(writer()).not.toContainText("외부에서 수정한 새 본문");
    await page.screenshot({ path: path.join(data, "03-external-change.png") });
    await focused().getByRole("button", { name: "바뀐 내용 불러오기", exact: true }).filter({ visible: true }).click();
    await expect(writer()).toContainText("외부에서 수정한 새 본문");
    await expect(conflict()).toHaveCount(0);
    await expect.poll(async () => (await library()).drafts.some(draft => draft.id === docs[0].id)).toBe(false);
  });
  await check("3. 외부 충돌 중 편집 사본 생성·양쪽 본문 보존", async () => {
    const doc = await read(docs[0].id);
    await fs.writeFile(doc.path, (await fs.readFile(doc.path, "utf8")).replace(doc.body, "외부 원본은 그대로 보존\n"));
    await expect(conflict()).toBeVisible({ timeout: 20000 });
    await writer().fill("충돌 중 작성한 나의 원고");
    await focused().getByRole("button", { name: "내 편집 사본 만들기", exact: true }).filter({ visible: true }).click();
    await expect(title()).toHaveValue(docs[0].title + " (내 편집 사본)");
    const copy = await currentMeta(docs[0].title + " (내 편집 사본)");
    expect((await read(copy.id)).body).toContain("충돌 중 작성한 나의 원고");
    expect((await read(docs[0].id)).body).toContain("외부 원본은 그대로 보존");
    await clearError();
  });
  await check("3. 저장 실패로 문서 이동 차단·충돌 원고 임시 보존", async () => {
    await open(docs[1]);
    const doc = await read(docs[1].id);
    await fs.writeFile(doc.path, (await fs.readFile(doc.path, "utf8")).replace(doc.body, "새 외부 버전\n"));
    await expect(conflict()).toBeVisible({ timeout: 20000 });
    await writer().fill("이동이 차단되어도 남겨 둘 내 원고");
    await tree(docs[2].id).click();
    await expect(page.locator(".error-banner")).toContainText("변경 충돌");
    await expect(title()).toHaveValue(docs[1].title);
    await expect.poll(async () => (await library()).drafts.find(draft => draft.id === docs[1].id)?.body).toContain("이동이 차단되어도 남겨 둘 내 원고");
    await clearError();
  });
  await check("3. 충돌 문서 닫기는 최신 파일 채택·재열기", async () => {
    await page.keyboard.press("Control+w");
    await open(docs[1]);
    await expect(writer()).toContainText("새 외부 버전");
    await expect(conflict()).toHaveCount(0);
  });
  await check("3. 수동 Git 이력 생성·이력 복원 후 저장", async () => {
    await writer().fill("이력으로 되돌릴 첫 본문"); await save();
    await expect.poll(async () => (await appCall("historyPage", { id: docs[1].id })).entries.length, { timeout: 20000 }).toBeGreaterThan(0);
    await writer().fill("이력 생성 뒤 두 번째 본문"); await save();
    await focused().getByRole("button", { name: "변경 이력", exact: true }).filter({ visible: true }).click();
    const entries = page.locator(".history-list > button");
    await expect.poll(() => entries.count()).toBeGreaterThan(1);
    let found = false;
    for (const entry of await entries.all()) {
      await entry.click();
      await page.getByRole("button", { name: "원고 보기", exact: true }).click();
      await expect(page.locator(".history-preview pre")).toBeVisible();
      if ((await page.locator(".history-preview pre").innerText()).includes("이력으로 되돌릴 첫 본문")) { found = true; break; }
    }
    expect(found).toBe(true);
    await page.getByRole("button", { name: "이 버전으로 복원", exact: true }).click();
    await expect(page.locator(".history-layout")).toHaveCount(0);
    await expect(writer()).toContainText("이력으로 되돌릴 첫 본문");
    expect((await read(docs[1].id)).body).toContain("이력으로 되돌릴 첫 본문");
    await writer().fill("이력 복원 후 이어 쓴 본문"); await save();
    expect((await read(docs[1].id)).body).toContain("이력 복원 후 이어 쓴 본문");
  });
  await check("3. 실제 창 닫기 요청의 저장·트레이 복귀", async () => {
    await writer().fill("네이티브 창 닫기 직전 입력");
    await page.evaluate(() => window.lof.windowClose());
    await expect.poll(async () => (await read(docs[1].id)).body).toContain("네이티브 창 닫기 직전 입력");
    await expect.poll(async () => (await library()).drafts.some(draft => draft.id === docs[1].id)).toBe(false);
    await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().show());
    await expect(writer()).toContainText("네이티브 창 닫기 직전 입력");
  });
  await expect(page.locator(".error-banner")).toHaveCount(0);
  expect(report.pageErrors).toEqual([]);
  report.passed = report.failedChecks.length === 0;
  if (!report.passed) process.exitCode = 1;
  delete report.currentCheck;
} catch (error) {
  report.failure = error.stack || String(error);
  if (page) {
    await page.screenshot({ path: path.join(data, "failure.png"), fullPage: true, timeout: 5000 }).catch(() => {});
    report.screen = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  }
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  if (page) {
    report.nativeTrace = await page.evaluate(() => window.__nativeTestTrace || []).catch(() => []);
    report.nativeErrors = report.nativeTrace.filter(item => !item.ok);
  }
  await browser?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, delay(5000)]);
  }
  report.cleanup.appExited = !child || child.exitCode !== null || child.signalCode !== null;
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  report.cleanup.serverClosed = !server?.listening;
  await fs.writeFile(path.join(data, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failedCheck: report.currentCheck, cleanup: report.cleanup, data }, null, 2));
}
