import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../core/store.mjs";

// 현재 React 화면을 테스트용 파일 저장소와 연결한다. Tauri 네이티브 기능은 대상에서 제외한다.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(root, ".test-data"), { recursive: true });
const data = await fs.mkdtemp(path.join(root, ".test-data", "editor-groups-"));
const store = await new Store(path.join(data, "vault")).init();
const project = await store.createProject({ title: "편집기 그룹 테스트" });
const docs = await Promise.all(["첫 원고", "둘째 원고", "셋째 원고"].map(title =>
  store.create({ projectId: project.id, kind: "episode", title, body: `${title}의 본문` })));
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
let preferences = { setupComplete: true, checkUpdatesOnStartup: false, textReplacementsVersion: 1 };
const checks = [];
const errors = [];
let browser, server, page;

async function backend(name, args = {}) {
  switch (name) {
    case "bootstrap": return { ...await store.list(), drafts: await store.drafts(), preferences, version };
    case "readDocument": return store.read(args.id);
    case "saveDocument": return store.save(args);
    case "saveDraft": return store.draft(args);
    case "clearDraft": return store.clearDraft(args.id);
    case "setPreferences": preferences = { ...preferences, ...args }; return preferences;
    case "searchText": return store.searchText(args.query, args.projectId, args);
    case "memoSpaces": return [{ id: "common", title: "공용 메모", root: path.join(data, "memo") }];
    case "memoTree": return { entries: [] };
    case "autoSyncStatus": return { phase: "idle", message: "", hasConnections: false };
    case "realtimeResetNotice": return false;
    case "countManuscript": return (await server.ssrLoadModule("/src/manuscript-counts.ts")).textCounts(args.text, args.rules);
    case "gitEditing": case "checkpointDocument": case "requestSyncNow":
    case "setTitleBarDimmed": case "setCompactWindow": return null;
    default: throw Error(`테스트 브리지에 없는 호출: ${name}`);
  }
}

try {
  server = await createServer({
    root, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { entries: ["index.html"] },
    plugins: [{
      name: "editor-groups-smoke",
      resolveId(id) { if (id === "/__editor-groups-smoke.js") return "\0editor-groups-smoke"; },
      load(id) {
        if (id === "\0editor-groups-smoke") return `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import App from '/src/App.tsx';
          import '/src/fonts.css';
          import '/src/style.css';
          createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(App)));
        `;
      },
      configureServer(instance) {
        instance.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__editor-groups-smoke") return next();
          const html = await instance.transformIndexHtml(req.url,
            '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__editor-groups-smoke.js"></script></body></html>');
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        });
      },
    }],
  });
  await server.listen();
  const executablePath = process.env.LOF_TEST_BROWSER || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("__lofTestCall", async (name, args) => {
    try { return { ok: true, data: await backend(name, args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
  await page.addInitScript(({ version }) => {
    try { localStorage.setItem("lof.releaseNotesSeenVersion", version); } catch {}
    window.lof = new Proxy({}, {
      get(_, name) {
        if (["onChange", "onFlush", "onAutoSync"].includes(name)) return () => () => {};
        if (String(name).startsWith("window")) return undefined;
        return args => window.__lofTestCall(name, args);
      },
    });
  }, { version });
  await page.goto(`${server.resolvedUrls.local[0]}__editor-groups-smoke`);
  const focused = () => page.locator(".content-shell .editor-group.focused, .content-shell .editor-groups:not(.split) > .editor-group");
  const title = () => focused().getByRole("textbox", { name: "문서 제목", exact: true }).filter({ visible: true });
  const tree = name => page.locator(".file-tree .tree-item").filter({ hasText: name });
  const tabs = () => page.locator(".content-shell .editor-groups .editor-tabs .editor-tab");
  const writer = () => focused().locator('[data-testid="manuscript"]');
  const check = label => { checks.push(label); console.log(`PASS ${label}`); };

  await page.locator(".project-card").filter({ hasText: project.title }).click();
  await page.locator(".episode-row").filter({ hasText: docs[0].title }).click();
  await expect(title()).toHaveValue(docs[0].title);
  await tree(docs[1].title).click();
  await expect(title()).toHaveValue(docs[1].title);
  await expect(tabs()).toHaveCount(1);
  await expect(tabs()).toHaveClass(/preview/);
  check("미리보기 탭 재사용");

  await tabs().dblclick();
  await expect(tabs()).not.toHaveClass(/preview/);
  await tree(docs[0].title).click();
  await expect(tabs()).toHaveCount(2);
  await writer().fill("탭 전환 전에 작성한 한글 원고");
  await expect(tabs().filter({ hasText: docs[0].title })).not.toHaveClass(/preview/);
  check("명시적 고정 및 편집 시 자동 고정");

  await tabs().filter({ hasText: docs[1].title }).click();
  await expect(title()).toHaveValue(docs[1].title);
  await expect.poll(async () => (await store.read(docs[0].id)).body).toContain("탭 전환 전에 작성한 한글 원고");
  check("탭 전환 전 원고 파일 저장");

  await page.keyboard.press("Control+Backslash");
  await expect(page.locator(".content-shell .editor-groups.split > .editor-group")).toHaveCount(2);
  await expect(page.locator(".content-shell .editor-group.focused")).toHaveAttribute("data-split-group", "right");
  await page.keyboard.press("Control+1");
  await expect(title()).toHaveValue(docs[0].title);
  await expect(writer()).toContainText("탭 전환 전에 작성한 한글 원고");
  await page.keyboard.press("Control+2");
  await expect(title()).toHaveValue(docs[1].title);
  check("분할 및 양쪽 그룹 포커스 전환·본문 보존");

  await page.keyboard.press("Control+w");
  await expect(page.locator(".content-shell .editor-groups > .editor-group")).toHaveCount(1);
  await expect(title()).toHaveValue(docs[0].title);
  check("그룹의 마지막 탭 닫기 후 남은 그룹 복귀");
  await page.keyboard.press("Control+w");
  await expect(page.locator(".workspace-empty")).toBeVisible();
  await expect(page.locator(".file-tree")).toBeVisible();
  await tree(docs[2].title).click();
  await expect(title()).toHaveValue(docs[2].title);
  check("전체 마지막 탭 닫기 및 파일 트리에서 다시 열기");

  await writer().fill("조합 중인 원고 보존");
  await writer().dispatchEvent("compositionstart");
  await tree(docs[0].title).dblclick();
  await expect(title()).toHaveValue(docs[0].title);
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect.poll(async () => (await store.read(docs[2].id)).body).toContain("조합 중인 원고 보존");
  check("입력 조합 상태와 무관하게 저장·전환");

  await tabs().filter({ hasText: docs[0].title }).dragTo(tabs().filter({ hasText: docs[2].title }));
  await expect(tabs().first()).toContainText(docs[0].title);
  await page.keyboard.press("Control+Tab");
  await expect(title()).toHaveValue(docs[2].title);
  await page.keyboard.press("Control+Shift+Tab");
  await expect(title()).toHaveValue(docs[0].title);
  check("탭 드래그 재정렬 및 순환 이동 단축키");

  await expect(page.locator(".error-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks, browserErrors: errors, data }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(data, "failure.png"), fullPage: true }).catch(() => {});
    console.error(JSON.stringify({ checks, browserErrors: errors, data }, null, 2));
  }
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
