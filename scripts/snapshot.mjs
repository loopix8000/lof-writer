import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { appCall, demoPreferences, loadDemoStory, prepareDemo } from "./snapshots/demo.mjs";
import { scenes } from "./snapshots/scenes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const options = { theme: "light", scenes: [], output: ".snapshots/latest", cover: "assets/demo/cover.png" };
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (["--list", "--plan", "--help", "--serve-dist", "--update-readme", "--update-site", "--render-only"].includes(key)) options[key.slice(2)] = true;
  else if (["--exe", "--output", "--cover", "--story", "--theme", "--since", "--scene"].includes(key)) {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error(`${key} 값이 필요합니다.`);
    if (key === "--scene") options.scenes.push(...value.split(","));
    else options[key.slice(2)] = value;
  } else throw Error(`알 수 없는 옵션: ${key}`);
}
if (!["light", "dark", "both"].includes(options.theme)) throw Error("테마는 light, dark, both 중에서 골라 주세요.");

async function git(...gitArgs) {
  return (await run("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true })).stdout.trim();
}

async function selection() {
  const unknown = options.scenes.filter(id => !scenes.some(scene => scene.id === id));
  if (unknown.length) throw Error(`없는 촬영 장면: ${unknown.join(", ")}`);
  let selected = scenes.filter(scene => !options.scenes.length || options.scenes.includes(scene.id));
  let changes = [], changedPaths = [];
  if (options.since) {
    const base = await git("rev-parse", "--verify", `${options.since}^{commit}`);
    changedPaths = (await git("diff", "--name-only", base, "HEAD")).split("\n").filter(Boolean);
    const log = await git("log", "--format=%H%x09%s", `${base}..HEAD`);
    changes = log ? log.split("\n").map(line => {
      const [commit, ...subject] = line.split("\t");
      return { commit, subject: subject.join("\t") };
    }) : [];
    selected = selected.filter(scene => scene.paths.some(file => changedPaths.includes(file)) ||
      (scene.commits || []).some(prefix => changes.some(change => change.commit.startsWith(prefix))));
    // 공통 부품이나 저장 형식 변경은 모든 화면에 영향을 줄 수 있다.
    if (changedPaths.some(file => ["package.json", "package-lock.json", "src/main.tsx", "src/tauri-bridge.ts", "src/types.ts", "src-tauri/src/lib.rs", "src-tauri/tauri.conf.json"].includes(file)))
      selected = scenes.filter(scene => !options.scenes.length || options.scenes.includes(scene.id));
  }
  return { selected, changes, changedPaths };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function writeReport(output, report) {
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
  const cards = report.captures.map(capture => `<article><h2>${escapeHtml(capture.title)} · ${capture.theme === "dark" ? "어두운 화면" : "밝은 화면"}</h2>${capture.status === "ok" ? `<a href="${capture.file}"><img src="${capture.file}" alt="${escapeHtml(capture.title)}" loading="lazy"></a>` : `<p class="error">촬영 실패: ${escapeHtml(capture.error)}</p>`}</article>`).join("\n");
  await fs.writeFile(path.join(output, "index.html"), `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lof Writer 데모 스냅샷</title><style>body{font-family:system-ui,sans-serif;max-width:1440px;margin:40px auto;padding:0 24px;background:#f5f6f8;color:#20242b}h1{margin-bottom:8px}article{margin:32px 0}h2{font-size:20px}img{width:100%;border:1px solid #ddd;border-radius:8px}p{line-height:1.7}.error{color:#b22}</style><h1>Lof Writer 데모 스냅샷</h1><p>${escapeHtml(report.attribution)}</p><p>작업 소스: ${escapeHtml(report.source.commit.slice(0, 12))} · 실행 앱: ${escapeHtml(report.appVersion || "연결 실패")}</p>${cards}</html>`);
}

async function marketingCaptures(output, report) {
  const required = ["editor", "project", "quick-note", "bookmarks", "split", "mobile", "table"];
  const captures = required.map(id => report.captures.find(item => item.id === id && item.theme === "light" && item.status === "ok"));
  if (captures.some(item => !item)) throw Error("소개 자료 갱신에는 editor, project, quick-note, bookmarks, split, mobile, table의 밝은 화면 촬영이 모두 필요합니다.");
  for (const capture of captures) {
    if (path.basename(capture.file) !== capture.file) throw Error("촬영 파일 경로가 잘못되었습니다.");
    const hash = createHash("sha256").update(await fs.readFile(path.join(output, capture.file))).digest("hex");
    if (hash !== capture.sha256) throw Error(`촬영 결과가 변경되었습니다: ${capture.file}`);
  }
  return captures;
}

async function copyMarketingImages(output, report, target) {
  const captures = await marketingCaptures(output, report);
  await fs.mkdir(target, { recursive: true });
  for (const capture of captures) {
    const source = path.join(output, capture.file), destination = path.join(target, `${capture.id}.png`);
    if (source !== destination) await fs.copyFile(source, destination);
  }
  // 공개할 출처 정보에는 임시 폴더나 사용자 경로를 포함하지 않는다.
  await fs.writeFile(path.join(target, "manifest.json"), JSON.stringify({
    createdAt: report.createdAt, source: report.source, appVersion: report.appVersion,
    viewport: report.viewport, demo: report.demo, attribution: report.attribution,
    captures: captures.map(({ id, title, sha256 }) => ({ id, title, file: `${id}.png`, sha256 })),
  }, null, 2) + "\n");
  return captures;
}

async function updateReadme(output, report) {
  const captures = await copyMarketingImages(output, report, path.join(root, "assets", "screenshots"));
  const descriptions = {
    editor: "원고를 쓰면서 글자 수와 연결된 플롯·메모를 함께 확인합니다. 문단 여백의 북마크와 메모 표시로 필요한 위치에 돌아갈 수 있습니다.",
    project: "표지와 작품 소개, 태그, 회차별 집필 상태를 한곳에서 관리합니다.",
    "quick-note": "원고에서 문장을 선택해 퀵 노트를 작성합니다. 제목과 생각을 적어 저장하면 원래 문장으로 돌아갈 수 있는 출처 링크가 남습니다.",
    bookmarks: "작품과 문서에 붙인 북마크를 한 화면에서 모아 보고, 원하는 문단으로 이동합니다.",
    split: "원고와 플롯 등 두 문서를 나란히 열어 내용을 비교하고 집필합니다.",
    mobile: "집필 중인 원고를 모바일 화면의 폭과 글자 크기로 미리 살펴봅니다.",
    table: "플롯과 메모의 표로 설정과 자료를 정리하고, 문서에 사용자 속성을 붙입니다.",
  };
  const section = [
    "<!-- demo-snapshots:start -->",
    report.attribution,
    `스크린샷은 데모 파이프라인에서 실제 앱으로 촬영했습니다. ${report.demo.caption}`,
    ...captures.flatMap(capture => [`### ${capture.title}`, descriptions[capture.id], `![${capture.title}](assets/screenshots/${capture.id}.png)`]),
    "<!-- demo-snapshots:end -->",
  ].join("\n\n");
  const file = path.join(root, "README.md");
  const original = await fs.readFile(file, "utf8");
  const marker = /<!-- demo-snapshots:start -->[\s\S]*?<!-- demo-snapshots:end -->/;
  let updated;
  if (marker.test(original)) updated = original.replace(marker, () => section);
  else {
    const intro = original.replace(/^<img\b[^>]*>\s*/m, "");
    if (!intro.includes("## 특징")) throw Error("README에서 소개 영역의 삽입 위치를 찾지 못했습니다.");
    updated = intro.replace("## 특징", () => `## 화면으로 살펴보기\n\n${section}\n\n## 특징`);
  }
  await fs.writeFile(file, updated);
}

async function updateSite(output, report) {
  const target = path.join(root, ".private");
  const captures = await copyMarketingImages(output, report, path.join(target, "assets", "screenshots"));
  await fs.copyFile(path.join(root, "assets", "icon.png"), path.join(target, "assets", "icon.png"));
  const descriptions = {
    project: "작품의 표지와 소개, 태그, 회차별 집필 상태를 한곳에서 관리합니다.",
    "quick-note": "선택한 문장에서 떠오른 생각을 바로 적으세요. 퀵 노트에 남은 출처 링크로 원래 원고에 돌아갈 수 있습니다.",
    bookmarks: "모든 작품의 북마크를 모아 보고, 필요한 문단으로 바로 이동합니다.",
    split: "원고와 플롯을 나란히 열어 이야기의 흐름을 확인하며 집필합니다.",
    mobile: "원고가 작은 화면에서 어떻게 읽히는지 집필 중에 확인합니다.",
    table: "표로 설정과 자료를 정리하고, 사용자 속성으로 필요한 정보를 붙입니다.",
  };
  const cards = captures.filter(capture => capture.id !== "editor").map(capture =>
    `<article class="showcase-item" id="demo-${capture.id}"><div class="showcase-copy"><h3>${escapeHtml(capture.title)}</h3><p>${escapeHtml(descriptions[capture.id])}</p></div><a class="screenshot-link" href="assets/screenshots/${capture.id}.png" aria-label="${escapeHtml(capture.title)} 큰 이미지 보기"><img src="assets/screenshots/${capture.id}.png" alt="Lof Writer ${escapeHtml(capture.title)} 화면" width="1440" height="960" loading="lazy" decoding="async"></a></article>`
  ).join("\n");
  const template = await fs.readFile(path.join(root, "scripts", "snapshots", "site-template.html"), "utf8");
  await fs.writeFile(path.join(target, "index.html"), template
    .replaceAll("{{demo-title}}", escapeHtml(report.demo.title))
    .replace("{{demo-caption}}", () => escapeHtml(report.demo.caption))
    .replace("{{attribution}}", () => escapeHtml(report.attribution))
    .replace("{{showcase}}", () => cards));
  console.log(`소개 페이지 저장: ${path.join(target, "index.html")}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function serveDist() {
  const dist = path.join(root, "dist");
  await fs.access(path.join(dist, "index.html"));
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      const file = path.resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
      if (path.relative(dist, file).startsWith("..")) { res.writeHead(403).end(); return; }
      const content = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(5173, "127.0.0.1", resolve); });
  return server;
}

async function waitUntil(fn, message, child) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`데모 앱이 종료되었습니다: ${child.exitCode}`);
    try { const result = await fn(); if (result) return result; } catch { /* 시작 중인 연결은 제한 시간 안에서 다시 확인한다. */ }
    await delay(200);
  }
  throw Error(message);
}

async function arrange(page, scene, demo, theme) {
  const doc = scene.document ? demo[scene.document] : demo.episodes[0];
  const view = scene.view || "workspace";
  await appCall(page, "setPreferences", { ...demoPreferences, ...scene.preferences, theme });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app").waitFor();
  await page.locator(".project-grid .project-card").first().waitFor();
  await page.waitForFunction(dark => document.querySelector(".app")?.classList.contains("dark") === dark, theme === "dark");
  // 서재에서 시작한 뒤 촬영할 화면을 직접 연다.
  if (view === "project") {
    await page.locator(".project-card").filter({ hasText: demo.project.title }).click();
    await page.locator(".project-hero").waitFor();
  } else if (view === "bookmarks") {
    await page.locator(".rail").getByRole("button", { name: "북마크", exact: true }).click();
    await page.locator(".bookmarks-page").waitFor();
  } else if (view === "workspace") {
    const openDocument = async target => {
      await page.keyboard.press("Control+p");
      await page.getByRole("textbox", { name: "파일 이름", exact: true }).fill(target.title);
      await page.getByRole("option").filter({ has: page.getByText(target.title, { exact: true }) }).click();
      await page.waitForFunction(title => document.querySelector('.editor-group.focused .document-title, .editor-groups:not(.split) .document-title')?.value === title, target.title);
    };
    await openDocument(doc);
    await openDocument(demo.episodes[1]);
    await page.locator(".editor-tab").filter({ has: page.getByText(doc.title, { exact: true }) }).click();
    if (scene.split) {
      await openDocument(demo.plot);
      await page.locator(".editor-tab.current").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^오른쪽으로 분할/ }).click();
      await page.locator('.editor-group[data-side="left"] .editor-tab').filter({ has: page.getByText(doc.title, { exact: true }) }).click();
      const groups = await page.locator(".editor-groups").boundingBox();
      const sash = await page.locator(".group-sash").boundingBox();
      await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
      await page.mouse.down();
      await page.mouse.move(groups.x + groups.width * 0.55, sash.y + sash.height / 2);
      await page.mouse.up();
    }
    await page.getByTestId("manuscript").waitFor();
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await page.locator(".editor-group.focused .save-indicator, .editor-group:not(.focused) .save-indicator").filter({ hasText: "저장됨" }).first().waitFor();
  }
  await scene.arrange?.(page, demo);
  await page.locator(".editor-scroll").evaluateAll(elements => {
    for (const element of elements) element.scrollTo(0, 0);
  });
  await page.locator(scene.ready).first().waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const error = page.locator(".error-banner");
  if (await error.isVisible()) throw Error(await error.innerText());
  // 마지막으로 누른 도구 막대의 호버 표시가 다음 장면에 남지 않게 한다.
  await page.mouse.move(2, 2);
}

async function main() {
  if (options.help) {
    console.log("데모 스냅샷: node scripts/snapshot.mjs --list | --plan [--since 커밋] | --exe 실행파일 [--serve-dist] [--scene 장면,...] [--theme light|dark|both] [--cover PNG] [--story 원고설정.json] [--output 폴더] [--update-readme] [--update-site] | --render-only --update-readme --update-site");
    return;
  }
  const { selected, changes, changedPaths } = await selection();
  if (options.list || options.plan) {
    console.log(JSON.stringify({ scenes: selected.map(({ id, title, commits = [], paths }) => ({ id, title, commits, paths })), changes, changedPaths }, null, 2));
    return;
  }
  if (options["render-only"]) {
    if (!options["update-readme"] && !options["update-site"]) throw Error("--render-only에는 --update-readme 또는 --update-site가 필요합니다.");
    const output = path.resolve(root, options.output);
    const report = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    if (options["update-readme"]) await updateReadme(output, report);
    if (options["update-site"]) await updateSite(output, report);
    return;
  }
  if (!selected.length) { console.log("변경 파일에 연결된 촬영 장면이 없습니다."); return; }
  if (!options.exe) throw Error("--exe로 촬영할 Tauri 실행파일을 지정해 주세요. 자동 빌드는 하지 않습니다.");
  const executable = path.resolve(root, options.exe), cover = path.resolve(root, options.cover);
  await Promise.all([fs.access(executable), fs.access(cover)]);
  const story = await loadDemoStory(root, options.story);
  const output = path.resolve(root, options.output);
  await fs.mkdir(output, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lof-writer-demo-"));
  const profile = path.join(workspace, "profile"), vault = path.join(workspace, "서재");
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "settings.json"), JSON.stringify({ preferences: demoPreferences, connections: [] }));
  const source = { commit: await git("rev-parse", "HEAD"), dirty: Boolean(await git("status", "--porcelain")) };
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(), source,
    executable: { name: path.basename(executable), sha256: createHash("sha256").update(await fs.readFile(executable)).digest("hex") },
    attribution: story.attribution || "예시 이미지와 텍스트는 기능 이해를 돕기 위해 생성형 AI를 사용해 제작했습니다.",
    viewport: { width: 1440, height: 960 }, changes, changedPaths, captures: [],
  };
  let child, browser, server, launchError;
  const interrupted = () => { launchError = Error("촬영이 중단되었습니다."); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    if (options["serve-dist"]) server = await serveDist();
    const port = await freePort();
    child = spawn(executable, [], {
      cwd: path.dirname(executable), windowsHide: true, stdio: "ignore",
      env: { ...process.env, LOF_USER_DATA: profile, LOF_VAULT: vault,
        WEBVIEW2_USER_DATA_FOLDER: path.join(workspace, "webview"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` },
    });
    child.once("error", error => { launchError = error; });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitUntil(async () => {
      if (launchError) throw launchError;
      return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
    }, "데모 WebView 연결 시간이 초과됐습니다. 개발 실행파일은 --serve-dist와 npm run build가 필요합니다.", child);
    browser = await chromium.connectOverCDP(endpoint);
    const page = await waitUntil(() => browser.contexts().flatMap(context => context.pages()).find(page => !page.url().startsWith("devtools:")), "앱 화면을 찾지 못했습니다.", child);
    page.setDefaultTimeout(12000);
    await page.waitForFunction(() => !!window.lof?.bootstrap);
    await page.locator(".app").waitFor();
    const runtime = JSON.parse(await fs.readFile(path.join(profile, "runtime.json"), "utf8"));
    if (runtime.pid !== child.pid) throw Error("촬영 프로필의 실행 프로세스가 일치하지 않습니다.");
    const initial = await appCall(page, "bootstrap");
    if (path.resolve(initial.root).toLowerCase() !== path.resolve(vault).toLowerCase()) throw Error("촬영용 서재 경로가 일치하지 않습니다.");
    report.appVersion = initial.version;
    await page.setViewportSize(report.viewport);
    const demo = await prepareDemo(page, { vault, cover, story });
    report.demo = {
      title: demo.project.title, chapters: demo.episodes.length,
      episodeCounts: demo.counts,
      listOnlyChapters: demo.listOnly.length,
      specials: demo.specials.map(({ title, episodeType }) => ({ title, episodeType })),
      caption: story.demoCaption || `예제 작품 「${story.title}」의 세 편으로 기능을 안내합니다.`,
      coverSha256: demo.coverHash,
    };
    const themes = options.theme === "both" ? ["light", "dark"] : [options.theme];
    for (const theme of themes) for (const scene of selected) {
      if (launchError) throw launchError;
      const file = `${scene.id}-${theme}.png`;
      const capture = { id: scene.id, title: scene.title, theme, file, commits: scene.commits || [] };
      try {
        await arrange(page, scene, demo, theme);
        const png = await page.screenshot({ path: path.join(output, file), animations: "disabled", caret: "hide" });
        capture.status = "ok";
        capture.sha256 = createHash("sha256").update(png).digest("hex");
        console.log(`촬영 완료: ${scene.title} (${theme})`);
      } catch (error) {
        capture.status = "failed";
        capture.error = error.message;
        console.error(`촬영 실패: ${scene.title} — ${error.message.split("\n")[0]}`);
        try { await page.screenshot({ path: path.join(output, `${scene.id}-${theme}-failed.png`), timeout: 3000 }); } catch { /* 실패 기록은 촬영 실패 여부와 별도로 남긴다. */ }
      }
      report.captures.push(capture);
      await writeReport(output, report);
    }
    if (options["update-readme"]) await updateReadme(output, report);
    if (options["update-site"]) await updateSite(output, report);
    if (report.captures.some(item => item.status !== "ok")) process.exitCode = 1;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
    console.error(`데모 파이프라인 실패: ${error.message}`);
  } finally {
    // 촬영 프로세스가 만든 앱만 종료한다. 원고·프로필은 확인할 수 있도록 남긴다.
    await browser?.close().catch(() => {});
    if (child?.pid && child.exitCode === null) {
      if (process.platform === "win32") await run("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      else child.kill("SIGTERM");
    }
    if (server) await new Promise(resolve => server.close(resolve));
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    report.demoWorkspace = workspace;
    await writeReport(output, report);
    console.log(`촬영 결과: ${path.join(output, "index.html")}`);
    console.log(`데모 서재: ${vault}`);
  }
}

await main().catch(error => { console.error(`데모 파이프라인 실패: ${error.message}`); process.exitCode = 1; });
