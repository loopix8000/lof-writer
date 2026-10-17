import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { readMarkdown } from "../core/markdown.mjs";
import { requiresSource } from "../core/text.mjs";
import { writeLabSummary } from "./summarize-rich-editor-lab.mjs";
import { checkRichEditorStability } from "./rich-editor-lab-stability.mjs";

// 제품 실행 파일·설정·서재와 분리한 정적 페이지에서만 입력한다.
const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const output = path.resolve(option("--output", ".test-data/rich-editor-lab"));
const fixture = path.resolve(option("--fixture", ".test-data/continuous-input/fixtures/카구야 오배송 1부.md"));
const sizes = option("--sizes", "100000,200000,300000").split(",").map(Number);
const modes = option("--modes", "writer-no-cursor,full,no-serialize,no-react,engine-only,minimal,source").split(",");
const repetitions = Number(option("--repetitions", "3"));
const samples = Number(option("--samples", "60"));
const interval = Number(option("--interval", "20"));
const position = option("--position", "end");
const profile = args.includes("--profile");
const stability = args.includes("--stability");
const layout = option("--layout", "original");
const channel = option("--browser", "msedge");
if (sizes.some(size => !Number.isInteger(size) || size < 1000) ||
    !Number.isInteger(repetitions) || repetitions < 1 || !Number.isInteger(samples) || samples < 1 || !Number.isFinite(interval) || interval < 1 ||
    !["start", "middle", "end"].includes(position) || !["original", "long-paragraphs"].includes(layout) ||
    (stability && modes.includes("source")) ||
    modes.some(mode => !["writer", "writer-no-cursor", "writer-visibility", "full", "no-serialize", "no-react", "engine-only", "minimal", "source", "content-visibility", "visibility-engine"].includes(mode)))
  throw Error("실험 인수를 확인해 주세요.");
const bytes = await fs.readFile(fixture);
const initialHash = createHash("sha256").update(bytes).digest("hex");
let { body } = readMarkdown(bytes.toString("utf8"));
if (body.length < Math.max(...sizes)) throw Error("실험 문서 길이가 요청한 글자 수보다 짧습니다.");
if (layout === "long-paragraphs") {
  const flat = body.replace(/\s+/g, " ");
  body = Array.from({ length: Math.ceil(Math.max(...sizes) / 3000) + 1 }, (_, i) =>
    flat.slice((i * 2998) % Math.max(1, flat.length - 2998), (i * 2998) % Math.max(1, flat.length - 2998) + 2998)).join("\n\n");
}
const fixtures = new Map(sizes.map(size => [size, body.slice(0, size)]));
for (const [size, text] of fixtures) {
  if (requiresSource(text, { tables: true, links: false, images: true }))
    throw Error(`${size}자 문서가 일반 편집 지원 범위를 벗어납니다.`);
}
await fs.mkdir(output, { recursive: true });
const frontend = path.join(output, "frontend");
const harnessHash = createHash("sha256");
for (const file of ["tests/rich-editor-lab/engine.tsx", "tests/rich-editor-lab/lab.css", "scripts/rich-editor-lab-stability.mjs"])
  harnessHash.update(await fs.readFile(path.join(root, file)));
const wrappers = {
  "/src/Writer.tsx": ["cursorLineAt"],
  "/src/manuscript-counts.ts": ["paragraphCountDelta"],
};
await build({
  root, configFile: false, base: "/", logLevel: "warn",
  plugins: [{
    name: "실험용-계측", enforce: "pre",
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      if (file.endsWith("/src/Writer.tsx")) code = code.replace("const inTable = useEditorState", "window.__labEditor = editor;\n  const inTable = useEditorState");
      if (file.endsWith("/src/SourceEditor.tsx")) code = code.replace("viewRef.current = view;", "viewRef.current = view; window.__labSource = view;");
      if (file.endsWith("/src/cached-markdown.ts")) {
        code = code.replace("function serialize(editor: Editor)", "function originalSerialize(editor: Editor)");
        code = code.replace("return { document, extension, serialize };", 'return { document, extension, serialize: (editor: Editor) => window.__labMeasure("markdown.serialize", () => originalSerialize(editor)) };');
      }
      const names = Object.entries(wrappers).find(([suffix]) => file.endsWith(suffix))?.[1] || [];
      for (const name of names) {
        const pattern = new RegExp(`(export )?function ${name}\\(`), match = code.match(pattern);
        if (!match) throw Error(`실험 계측 함수를 찾지 못했습니다: ${name}`);
        code = code.replace(pattern, `function original_${name}(`);
        code += `\n${match[1] || ""}function ${name}(...args: Parameters<typeof original_${name}>) { return window.__labMeasure(${JSON.stringify(name)}, () => original_${name}(...args)); }\n`;
      }
      return { code, map: null };
    },
  }, react()],
  build: { outDir: frontend, emptyOutDir: false, sourcemap: true, target: "es2022",
    rollupOptions: { input: path.join(root, "tests/rich-editor-lab/index.html") } },
});

let currentFixture = "";
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/fixture.md") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end(currentFixture); return; }
  const file = path.resolve(frontend, "." + decodeURIComponent(url.pathname));
  if (!file.startsWith(frontend + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" })[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const report = { fixture, initialHash, frontend, sizes, modes, repetitions, samples, interval, position, layout, stability,
  harnessSha256: harnessHash.digest("hex"), candidate: "content-visibility:auto + overflow-clip-margin:64px",
  environment: { platform: process.platform, node: process.version }, results: [], errors: [] };
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;
const summarize = values => ({ median: quantile(values, .5), p95: quantile(values, .95), max: Math.max(0, ...values), total: values.reduce((a, b) => a + b, 0), calls: values.length });
try {
  browser = await chromium.launch({ channel, headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
  report.environment.browser = browser.version();
  // 순서에 따른 예열·발열 편향을 줄이기 위해 반복마다 비교군 순서를 뒤집는다.
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const size of sizes) for (const mode of repeat % 2 ? [...modes].reverse() : modes) {
      currentFixture = fixtures.get(size);
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      page.on("pageerror", error => report.errors.push({ size, mode, repeat, message: error.message, stack: error.stack }));
      const cdp = await context.newCDPSession(page);
      const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
      await cdp.send("Performance.enable");
      const loadStart = performance.now();
      await page.goto(`http://127.0.0.1:${server.address().port}/tests/rich-editor-lab/index.html?mode=${mode}`);
      await page.waitForFunction(source => !!window.__lab?.mounted && (source ? !!window.__labSource : !!window.__labEditor), mode === "source");
      await page.evaluate(({ mode, position }) => {
        const editor = window.__labEditor, cm = window.__labSource;
        if (mode === "source") {
          const length = cm.state.doc.length;
          const at = position === "start" ? 0 : position === "middle" ? Math.floor(length / 2) : length;
          cm.dispatch({ selection: { anchor: at }, scrollIntoView: true }); cm.focus();
        } else {
          window.__lab.instrument();
          const end = editor.state.doc.content.size - 1;
          const at = position === "start" ? 1 : position === "middle" ? Math.floor(end / 2) : end;
          editor.commands.setTextSelection(at); editor.commands.focus();
          const dom = editor.view.domAtPos(editor.state.selection.head).node;
          (dom.nodeType === 1 ? dom : dom.parentElement).scrollIntoView({ block: "center" });
        }
      }, { mode, position });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const loadMs = performance.now() - loadStart;
      // 입력 전에 한 번만 전체 글을 읽어 입력 누락·중복·선택 위치를 나중에 대조한다.
      const before = await page.evaluate(mode => {
        if (mode === "source") {
          const view = window.__labSource;
          return { text: view.state.doc.toString(), at: view.state.selection.main.from };
        }
        const editor = window.__labEditor;
        return { text: editor.state.doc.textContent, at: editor.state.doc.textBetween(0, editor.state.selection.from, "", "").length };
      }, mode);
      // 입력·JIT·글꼴 준비의 최초 한 번 비용은 측정에서 제외한다.
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
      await page.waitForTimeout(120);
      const warmed = await page.evaluate(mode => mode === "source" ? window.__labSource.state.doc.toString() : window.__labEditor.state.doc.textContent, mode);
      if (warmed !== before.text.slice(0, before.at) + "a" + before.text.slice(before.at)) throw Error("예열 입력 검증 실패");
      if (profile) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 }); await cdp.send("Profiler.start"); }
      await page.evaluate(() => window.__lab.reset());
      const firstMetrics = await metrics();
      // 브라우저와 호스트 시계 차이는 가장 짧은 왕복 시간의 중점으로 추정한다.
      let sync;
      for (let i = 0; i < 5; i++) {
        const hostStart = performance.now(), browserTime = await page.evaluate(() => performance.now()), hostEnd = performance.now();
        if (!sync || hostEnd - hostStart < sync.rtt) sync = { offset: browserTime - (hostStart + hostEnd) / 2, rtt: hostEnd - hostStart };
      }
      const hostStart = performance.now() + 80, intendedStart = hostStart + sync.offset;
      const sendTimes = [], acknowledgements = [];
      await Promise.all(Array.from({ length: samples }, (_, i) => new Promise((resolve, reject) => {
        setTimeout(() => {
          sendTimes[i] = performance.now() + sync.offset;
          cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", unmodifiedText: "a", autoRepeat: i > 0 })
            .then(() => { acknowledgements[i] = performance.now() + sync.offset; resolve(); }, reject);
        }, Math.max(0, hostStart + i * interval - performance.now()));
      })));
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const lastMetrics = await metrics();
      const raw = await page.evaluate(() => {
        const result = window.__lab.snapshot();
        const cm = window.__labSource, editor = window.__labEditor;
        return { ...result, finalText: cm ? cm.state.doc.toString() : editor.state.doc.textContent };
      });
      if (profile) {
        const { profile: cpu } = await cdp.send("Profiler.stop");
        await fs.writeFile(path.join(output, `${size}-${mode}-${repeat}-typing.cpuprofile`), JSON.stringify(cpu));
      }
      const expected = before.text.slice(0, before.at) + "a".repeat(samples + 1) + before.text.slice(before.at);
      // DOM 관찰자가 여러 입력을 한 트랜잭션으로 합칠 수 있으므로 갱신 횟수는 키 수와 다를 수 있다.
      if (raw.finalText !== expected || raw.keys.length !== samples || raw.inputs !== samples || raw.updates < 1)
        throw Error(`입력 무결성 검증 실패: ${size}/${mode}, key=${raw.keys.length}, input=${raw.inputs}, update=${raw.updates}`);
      delete raw.finalText;
      const result = { size, mode, repeat, loadMs, clockErrorBoundMs: sync.rtt / 2,
        ...raw, stages: Object.fromEntries(Object.entries(raw.stages).map(([key, values]) => [key, summarize(values)])),
        queueMs: summarize(raw.keys.map((event, i) => event.start - sendTimes[i])),
        scheduleLagMs: summarize(sendTimes.map((at, i) => at - (intendedStart + i * interval))),
        nextFrameMs: summarize(raw.frames.map(frame => frame.first - sendTimes[frame.key])),
        secondFrameMs: summarize(raw.frames.map(frame => frame.second - sendTimes[frame.key])),
        ackMs: summarize(acknowledgements.map((at, i) => at - sendTimes[i])),
        metrics: Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"].map(key => [key, lastMetrics[key] - firstMetrics[key]])),
      };
      if (stability) {
        result.stability = await checkRichEditorStability(page, cdp);
        if (!result.stability.ok) report.errors.push({ size, mode, repeat, message: "편집 동작 안정성 검증에 실패했습니다.", checks: result.stability.checks.filter(check => !check.ok) });
      }
      report.results.push(result);
      await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
      console.log(`${repeat + 1}/${repetitions} · ${size}자 · ${mode}: 다음 프레임 p95 ${result.nextFrameMs.p95.toFixed(1)}ms / 대기 p95 ${result.queueMs.p95.toFixed(1)}ms / 처리 ${result.stages["dispatch.total"]?.total.toFixed(1) ?? "-"}ms`);
      await context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  report.fixtureUnchanged = createHash("sha256").update(await fs.readFile(fixture)).digest("hex") === initialHash;
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
await writeLabSummary(report, output);
console.log(`결과 저장: ${path.join(output, "report.md")}`);
if (!report.fixtureUnchanged || report.errors.length) throw Error("문서 보존 또는 화면 오류 검증 실패. 보고서의 제외 항목을 확인해 주세요.");
