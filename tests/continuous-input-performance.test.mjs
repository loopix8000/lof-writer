import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { Marked } from "marked";
import { getSchema, resolveExtensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { MarkdownManager } from "@tiptap/markdown";
import { EditorState } from "@tiptap/pm/state";
import { requiresSource, splitSoftBreaks, plainText } from "../core/text.mjs";
import { inMarkdownCode, typingPlan } from "../core/typing.mjs";
import { normalizeWriting } from "../core/platforms.mjs";
import { readMarkdown } from "../core/markdown.mjs";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, ".test-data/continuous-input");
await fs.mkdir(output, { recursive: true });
// 실제 구현을 변환해 읽는다. 진단 코드에 구현을 복제하지 않는다.
async function loadTypeScript(file) {
  const source = path.join(root, "src", file);
  const code = ts.transpileModule(await fs.readFile(source, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from "(\.\.?\/[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(source), relative)).href)}`);
  const target = path.join(output, file.replace(/\.ts$/, ".mjs"));
  await fs.writeFile(target, code);
  return import(pathToFileURL(target).href);
}
const { paragraphCountDelta } = await loadTypeScript("manuscript-counts.ts");
const { createCachedMarkdown } = await loadTypeScript("cached-markdown.ts");
const sourceDir = process.env.LOF_PERF_FIXTURES || path.join(output, "fixtures");
const names = ["02. 카구야 오배송 통합본.md", "카구야 오배송 1부.md", "카구야 오배송 2부.md", "카구야 오배송 3부.md"];
const hash = value => createHash("sha256").update(value).digest("hex");
const fixtures = (await Promise.all(names.map(async name => {
  const file = path.join(sourceDir, name);
  try {
    const bytes = await fs.readFile(file);
    return { name, file, hash: hash(bytes), ...readMarkdown(bytes.toString("utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}))).filter(Boolean);
const report = { samples: 24, files: [], originalFilesUnchanged: false };
function measure(fn, samples = 24) {
  const values = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now(); fn(i); values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.min(values.length - 1, Math.floor(values.length * .95))], totalMs: values.reduce((a, b) => a + b, 0) };
}

test("원문 보호 검사는 같은 본문만 캐시하고 매 글자 변경마다 전체 본문을 다시 해석한다", () => {
  const original = Marked.prototype.lexer;
  let calls = 0, totalCharacters = 0;
  Marked.prototype.lexer = function (body, ...args) { calls++; totalCharacters += body.length; return original.call(this, body, ...args); };
  try {
    const body = "원문 검사 캐시\n\n" + (fixtures[0]?.body || "성능 검사 문단\n\n".repeat(3_000));
    for (let i = 0; i < 24; i++) requiresSource(body, { tables: true, links: true, images: true });
    assert.equal(calls, 1);
    calls = 0; totalCharacters = 0;
    for (let i = 0; i < 24; i++) requiresSource(body + "a".repeat(i + 1), { tables: true, links: true, images: true });
    assert.equal(calls, 24);
    assert.ok(totalCharacters >= body.length * 24);
    console.log(`본문 변경 24회: 전체 파싱 ${calls}회, 누적 ${totalCharacters.toLocaleString()}자`);
  } finally { Marked.prototype.lexer = original; }
});

test("원문 코드 영역 검사는 입력 위치 앞의 모든 줄을 두 번 분리한다", () => {
  const prefix = fixtures[1]?.body || "성능 검사 문단\n\n".repeat(27_000);
  const splits = [];
  const wrapped = { split(separator, limit) { splits.push({ separator, limit }); return prefix.split(separator, limit); } };
  assert.equal(inMarkdownCode(wrapped), inMarkdownCode(prefix));
  assert.equal(splits.length, 2);
  assert.ok(splits.every(entry => entry.limit === undefined));
});

test("문단 증감 계산은 긴 문서의 변경 문단만 세며 실제 입력·삭제 수와 일치한다", () => {
  const schema = getSchema([StarterKit]);
  const doc = schema.node("doc", null, Array.from({ length: 27_000 }, (_, i) => schema.node("paragraph", null, schema.text(`원고 문단 ${i}`))));
  const rules = normalizeWriting({ platform: "custom" });
  for (const fraction of [0, .5, 1]) {
    const position = Math.max(1, Math.min(doc.content.size - 1, Math.floor(doc.content.size * fraction)));
    const before = EditorState.create({ doc });
    const after = before.tr.insertText("가", position).doc;
    const delta = paragraphCountDelta(doc, after, rules);
    assert.equal(delta.utf16WithoutSpaces, 1);
    assert.equal(delta.utf8Bytes, 3);
    assert.equal(paragraphCountDelta(after, doc, rules).utf16WithoutSpaces, -1);
  }
});

test("실제 네 원고의 입력 경로를 각각 측정하고 원본을 보존한다", {
  skip: fixtures.length !== 4 ? "진단 원고 사본이 없습니다. LOF_PERF_FIXTURES로 사본 폴더를 지정해 주세요." : false,
}, async () => {
  for (const fixture of fixtures) {
    const cached = createCachedMarkdown();
    const baseExtensions = [StarterKit.configure({ document: false }), cached.document];
    const extensions = resolveExtensions(baseExtensions);
    const manager = new MarkdownManager({ marked: new Marked(), extensions });
    const schema = getSchema(baseExtensions);
    const prepared = splitSoftBreaks(fixture.body, fixture.properties.manualLineBreak !== true);
    const doc = schema.nodeFromJSON(manager.parse(prepared));
    const state = EditorState.create({ doc });
    const fakeEditor = { state, markdown: manager };
    cached.serialize(fakeEditor);
    const variants = Array.from({ length: 24 }, (_, i) => state.tr.insertText("a".repeat(i + 1), doc.content.size - 1).doc);
    const rules = normalizeWriting({ platform: "custom" });
    const result = {
      name: fixture.name, characters: fixture.body.length, paragraphs: doc.childCount,
      requiresSourceChanged: measure(i => requiresSource(fixture.body + "a".repeat(i + 1), { tables: true, links: true, images: true })),
      workerPlainText: measure(i => plainText(fixture.body + "a".repeat(i + 1))),
      inMarkdownCodeEnd: measure(() => inMarkdownCode(fixture.body)),
      typingPlanEnd: measure(() => typingPlan(fixture.body, "", "", "a")),
      paragraphDeltaEnd: measure(i => paragraphCountDelta(doc, variants[i], rules)),
      cachedMarkdownSerialize: measure(i => cached.serialize({ ...fakeEditor, state: { doc: variants[i] } })),
    };
    report.files.push(result);
    console.log(JSON.stringify(result));
    assert.equal(hash(await fs.readFile(fixture.file)), fixture.hash);
  }
  report.originalFilesUnchanged = true;
  await fs.writeFile(path.join(output, "unit-report.json"), JSON.stringify(report, null, 2));
});
