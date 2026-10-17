import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { readMarkdown } from "../core/markdown.mjs";
import { manuscriptStats, requiresSource, splitSoftBreaks, plainText } from "../core/text.mjs";

// 지정한 원고는 읽기만 한다. 원고 사본과 모든 편집은 별도 서재에서만 수행한다.
const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2), files = [];
let exe = "C:/Projects/lof-writer/release/win-unpacked/Lof Writer.exe";
let output = path.join(root, ".test-data", `editor-performance-${Date.now()}`);
let frontend, samples = 5, composition = false, mode = "rich", continuous = false, repeatMs, bypassSource = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exe") exe = path.resolve(args[++i]);
  else if (args[i] === "--output") output = path.resolve(args[++i]);
  else if (args[i] === "--frontend") frontend = path.resolve(args[++i]);
  else if (args[i] === "--samples") samples = Number(args[++i]);
  else if (args[i] === "--composition") composition = true;
  else if (args[i] === "--mode") mode = args[++i];
  else if (args[i] === "--continuous") continuous = true;
  else if (args[i] === "--repeat-ms") repeatMs = Number(args[++i]);
  else if (args[i] === "--bypass-source") bypassSource = true;
  else files.push(path.resolve(args[i]));
}
if (!files.length) throw Error("진단할 Markdown 파일 경로를 지정해 주세요.");
if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw Error("입력 횟수는 1~100 사이의 정수여야 합니다.");
if (!["rich", "source", "native"].includes(mode)) throw Error("편집 방식은 rich, source, native 중 하나여야 합니다.");
if (repeatMs !== undefined && (!Number.isFinite(repeatMs) || repeatMs < 1)) throw Error("키 반복 간격은 양수여야 합니다.");
const profile = path.join(output, "profile"), vault = path.join(output, "vault");
await fs.mkdir(profile, { recursive: true });
let preferences = {};
try { preferences = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "Lof Writer", "settings.json"), "utf8")).preferences || {}; } catch { /* 기존 설정이 없으면 기본 설정을 쓴다. */ }
await fs.writeFile(path.join(profile, "settings.json"), JSON.stringify({ preferences: { ...preferences, setupComplete: true, checkUpdatesOnStartup: false }, connections: [] }));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { executable: exe, frontend, output, samples, composition, mode, continuous, repeatMs, bypassSource, files: [], errors: [], originalFilesUnchanged: false };
const sources = [];
for (const file of files) {
  const bytes = await fs.readFile(file), { body, properties } = readMarkdown(bytes.toString("utf8"));
  const sample = (fn) => { const start = performance.now(); fn(); return +(performance.now() - start).toFixed(2); };
  const info = {
    name: path.basename(file), path: file, sha256: hash(bytes), bytes: bytes.length,
    characters: body.length, lines: body.split("\n").length,
    manualLineBreak: properties.manualLineBreak === true,
    coreMs: { stats: sample(() => manuscriptStats(body)), sourceDetection: sample(() => requiresSource(body, { tables: true, links: true, images: true })), splitParagraphs: sample(() => splitSoftBreaks(body, properties.manualLineBreak !== true)) },
  };
  report.files.push(info); sources.push({ body, properties, info });
  console.log(`원고 준비: ${info.name} / ${info.characters.toLocaleString()}자 / ${info.lines.toLocaleString()}줄`);
}
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
let child, browser, staticServer;
const appCall = (page, method, args = {}) => page.evaluate(async ({ method, args }) => {
  const response = await window.lof[method](args);
  if (!response.ok) throw Error(response.error);
  return response.data;
}, { method, args });
try {
  // 개발 실행 파일의 기존 devUrl에 완성된 정적 번들만 제공한다. tauri dev나 Vite 개발 서버는 띄우지 않는다.
  if (frontend) {
    staticServer = http.createServer(async (req, res) => {
      const relative = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(frontend, relative);
      if (!file.startsWith(frontend + path.sep)) { res.writeHead(403).end(); return; }
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(file)] || "application/octet-stream";
      try { const content = await fs.readFile(file); res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(content); }
      catch { if (!res.headersSent) res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { staticServer.once("error", reject); staticServer.listen(5173, "127.0.0.1", resolve); });
  }
  child = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true, stdio: "ignore", env: {
    ...process.env, LOF_USER_DATA: profile, LOF_VAULT: vault, WEBVIEW2_USER_DATA_FOLDER: path.join(output, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  } });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch { /* WebView 시작을 기다린다. */ }
    if (child.exitCode !== null) throw Error("진단용 앱이 종료되었습니다.");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages().find(page => !page.url().startsWith("devtools:"));
  page.setDefaultTimeout(90_000);
  page.on("pageerror", error => { report.errors.push(error.message); console.error(`화면 오류: ${error.message}`); });
  await page.waitForFunction(() => !!window.lof?.bootstrap);
  if (frontend && !page.url().startsWith("http://127.0.0.1:5173")) throw Error(`--frontend 비교에는 개발 실행 파일이 필요합니다. 현재 주소: ${page.url()}`);
  const initial = await appCall(page, "bootstrap");
  if (path.resolve(initial.root).toLowerCase() !== vault.toLowerCase()) throw Error("진단용 서재 경로가 다릅니다.");
  if (initial.projects.length || initial.documents.length) throw Error("결과 폴더에 기존 진단 서재가 있습니다. 새 결과 폴더를 지정해 주세요.");
  const project = await appCall(page, "createProject", { title: "편집 성능 진단" });
  for (const source of sources) {
    const created = await appCall(page, "createDocument", { projectId: project.id, kind: "memo", title: source.info.name.replace(/\.md$/i, ""), body: source.body, manualLineBreak: source.info.manualLineBreak });
    source.id = created.id;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const delta = (before, after) => Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount", "Nodes", "JSHeapUsedSize"].map(key => [key, after[key] - before[key]]));
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.lof?.bootstrap);
    await page.locator(".project-card").first().waitFor();
    source.info.scriptUrls = await page.evaluate(() => [...document.scripts].map(script => script.src));
    await page.evaluate(() => {
      window.__perf = { rpc: [], events: [], stages: {}, input: [], longTasks: [] };
      const record = (key, ms) => { const stage = window.__perf.stages[key] ||= { calls: 0, totalMs: 0, maxMs: 0 }; stage.calls++; stage.totalMs += ms; stage.maxMs = Math.max(stage.maxMs, ms); };
      window.__perf.record = record;
      for (const name of ["readDocument", "saveDocument", "saveDraft", "bootstrap", "countManuscript"]) {
        const original = window.lof[name];
        window.lof[name] = async (...args) => { const start = performance.now(); try { return await original(...args); } finally { window.__perf.rpc.push({ name, ms: performance.now() - start }); } };
      }
      new PerformanceObserver(list => { for (const task of list.getEntries()) window.__perf.longTasks.push({ start: task.startTime, ms: task.duration }); }).observe({ type: "longtask", buffered: false });
      const originalPost = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args) {
        const start = performance.now();
        try { return originalPost.apply(this, args); }
        finally { record("worker.postMessage", performance.now() - start); }
      };
    });
    await page.keyboard.press("Control+p");
    await page.getByRole("textbox", { name: "파일 이름", exact: true }).fill(source.info.name.replace(/\.md$/i, ""));
    const option = page.getByRole("option").filter({ has: page.getByText(source.info.name.replace(/\.md$/i, ""), { exact: true }) });
    const before = await metrics();
    await cdp.send("Profiler.start");
    const openStart = performance.now();
    await option.click();
    await page.getByTestId("manuscript").waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    source.info.openMs = +(performance.now() - openStart).toFixed(1);
    source.info.openMetrics = delta(before, await metrics());
    const opened = await cdp.send("Profiler.stop");
    await fs.writeFile(path.join(output, `${index + 1}-open.cpuprofile`), JSON.stringify(opened.profile));
    source.info.editor = await page.evaluate(() => {
      const dom = document.querySelector('[data-testid="manuscript"]'), editor = dom.editor;
      window.__editor = editor;
      const wrap = (owner, key, label) => { const original = owner[key]; owner[key] = function (...args) { const start = performance.now(); try { return original.apply(this, args); } finally { window.__perf.record(label, performance.now() - start); } }; };
      wrap(editor.view, "dispatch", "dispatch"); wrap(editor.view, "updateState", "view.updateState");
      wrap(editor, "emit", "editor.emit"); wrap(editor.markdown, "serialize", "markdown.serialize"); wrap(editor.markdown, "parse", "markdown.parse");
      for (const field of editor.state.config.fields) wrap(field, "apply", `state.${field.name}`);
      dom.addEventListener("beforeinput", () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__perf.input.push(performance.now() - start))); });
      return { blocks: editor.state.doc.childCount, nodes: dom.querySelectorAll("*").length, textLength: editor.state.doc.textContent.length, parserType: typeof editor.markdown.instance, tableStartCallbacks: editor.markdown.instance.defaults.extensions?.startBlock?.length || 0, plugins: editor.state.plugins.map(plugin => plugin.key) };
    });
    source.info.openRpc = await page.evaluate(() => window.__perf.rpc.splice(0));
    source.info.idleCountRpcMs = await page.evaluate(async text => {
      const values = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const result = await window.lof.countManuscript({ text, rules: { rule: "noSpace" } });
        if (!result.ok) throw Error(result.error);
        values.push(performance.now() - start);
      }
      return values;
    }, plainText(source.body));
    if (bypassSource) await page.evaluate(() => { window.__perf.bypassSource = true; });
    console.log(`열기 측정: ${source.info.name} / ${source.info.openMs}ms / ${source.info.editor.blocks.toLocaleString()}블록`);
    if (mode !== "rich") {
      await page.getByRole("button", { name: "Markdown 모드", exact: true }).click();
      await page.getByRole("textbox", { name: "Markdown 원문", exact: true }).waitFor();
      await page.waitForTimeout(400);
      await page.evaluate(mode => {
        const original = document.querySelector('textarea[aria-label="Markdown 원문"]');
        const content = document.querySelector('.source-editor .cm-content');
        // 계측 번들의 공개 뷰를 우선 쓴다. 배포본 비교에서는 DOM에 연결된 뷰를 찾는다.
        const view = window.__sourceEditor ?? content?.cmTile?.root?.view;
        if (!original && !view) throw Error("진단할 원문 편집기를 찾지 못했습니다.");
        let area = original;
        if (mode === "native") {
          // 같은 WebView·본문에서 앱 이벤트 처리를 제거한 기본 입력창과 비교한다.
          area = document.createElement("textarea"); area.setAttribute("aria-label", "Markdown 원문");
          area.value = original ? original.value : view.state.doc.toString();
          (original ?? view.dom).replaceWith(area);
        }
        window.__sourceValue = () => area ? area.value : view.state.doc.toString();
        window.__sourcePosition = fraction => {
          const position = Math.round(window.__sourceValue().length * fraction);
          if (area) { area.focus(); area.setSelectionRange(position, position); }
          else { view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus(); }
        };
        const input = area ?? view.contentDOM;
        input.addEventListener("beforeinput", () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__perf.input.push(performance.now() - start))); });
      }, mode);
      source.info.initialSourceLength = await page.evaluate(() => window.__sourceValue().length);
    }
    source.info.typing = [];
    await cdp.send("Profiler.start");
    for (const [label, fraction] of [["시작", 0], ["중간", 0.5], ["끝", 1]]) {
      await page.evaluate(({ fraction, mode }) => {
        if (mode !== "rich") {
          window.__sourcePosition(fraction); return;
        }
        const editor = window.__editor, position = Math.max(1, Math.min(editor.state.doc.content.size - 1, Math.round(editor.state.doc.content.size * fraction)));
        editor.chain().focus().setTextSelection(position).run();
      }, { fraction, mode });
      await page.waitForTimeout(100);
      await page.evaluate(() => { window.__perf.stages = {}; window.__perf.input = []; window.__perf.longTasks = []; });
      const before = await metrics(), start = performance.now();
      const repeatAcks = [];
      if (repeatMs !== undefined) {
        // 입력 완료를 기다리지 않고 OS 키 반복처럼 일정 간격으로 전달한다.
        await Promise.all(Array.from({ length: samples }, (_, i) => new Promise(resolve => setTimeout(resolve, i * repeatMs)).then(async () => {
          const sent = performance.now();
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", unmodifiedText: "a", windowsVirtualKeyCode: 65, autoRepeat: i > 0 });
          repeatAcks.push({ index: i, scheduleMs: i * repeatMs, sentMs: sent - start, ackMs: performance.now() - start, latencyMs: performance.now() - sent });
        })));
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      }
      else if (continuous) await page.keyboard.type("a".repeat(samples));
      else for (let i = 0; i < samples; i++) await page.keyboard.insertText("가");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const elapsed = performance.now() - start;
      const result = await page.evaluate(() => ({ stages: window.__perf.stages, inputMs: window.__perf.input, longTasks: window.__perf.longTasks, rpc: window.__perf.rpc.splice(0) }));
      source.info.typing.push({ position: label, elapsedMs: +elapsed.toFixed(1), repeatAcks, metrics: delta(before, await metrics()), ...result });
      console.log(`입력 측정: ${source.info.name} / ${label} / ${samples}자 ${elapsed.toFixed(1)}ms`);
      await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    }
    const typed = await cdp.send("Profiler.stop");
    await fs.writeFile(path.join(output, `${index + 1}-typing.cpuprofile`), JSON.stringify(typed.profile));
    if (composition) {
      const start = performance.now();
      for (const text of ["ㅎ", "하", "한"]) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await cdp.send("Input.insertText", { text: "한" });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      source.info.compositionMs = +(performance.now() - start).toFixed(1);
    }
    const textLength = await page.evaluate(mode => mode === "rich" ? window.__editor.state.doc.textContent.length : window.__sourceValue().length, mode);
    source.info.inputPreserved = textLength === (mode === "rich" ? source.info.editor.textLength : source.info.initialSourceLength) + samples * 3 + (composition ? 1 : 0);
    if (!source.info.inputPreserved) throw Error(`${source.info.name}: 입력한 글자 수가 다릅니다.`);
    if (mode !== "native") {
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => [...document.querySelectorAll(".save-indicator")].some(el => el.textContent.includes("저장됨")));
    const saved = await appCall(page, "readDocument", { id: source.id });
    source.info.saveMatchesEditor = saved.body === await page.evaluate(mode => mode === "rich" ? window.__editor.getMarkdown() : window.__sourceValue(), mode);
    if (!source.info.saveMatchesEditor) throw Error(`${source.info.name}: 저장한 본문이 편집기와 다릅니다.`);
    }
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  }
} catch (error) {
  report.errors.push(error.stack || String(error)); process.exitCode = 1; console.error(`성능 진단 실패: ${error.message}`);
} finally {
  await browser?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) child.kill();
  if (staticServer?.listening) await new Promise(resolve => staticServer.close(resolve));
  report.originalFilesUnchanged = (await Promise.all(report.files.map(async file => hash(await fs.readFile(file.path)) === file.sha256))).every(Boolean);
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`진단 결과: ${path.join(output, "report.json")} / 원본 보존: ${report.originalFilesUnchanged}`);
}
