import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../core/store.mjs";
import { typingPlan, pairedBackspace, inMarkdownCode, migrateTypingPreferences } from "../core/typing.mjs";
import { manuscriptStats, countForRule } from "../core/text.mjs";
import { normalizeWriting } from "../core/platforms.mjs";
test("자동 닫기: 커서, 선택 감싸기, 닫는 문자 건너뛰기, 축약형과 조합 보호", () => {
  assert.deepEqual(typingPlan("", "", "", '"').insert, '""');
  assert.equal(typingPlan("", "", '"', '"').skip, 1);
  assert.equal(
    typingPlan("", "한글", "", '"', { quoteStyle: "curly" }).insert,
    "“한글”",
  );
  assert.equal(
    typingPlan("안녕", "", "”", '"', { quoteStyle: "curly" }).skip,
    1,
  );
  assert.equal(typingPlan("don", "", "t", "'"), null);
  assert.equal(typingPlan("", "", "", '"', { composing: true }), null);
  assert.equal(typingPlan("", "", "", '"', { inCode: true }), null);
  assert.equal(typingPlan("", "", "", '"', { autoCloseQuotes: false }), null);
  assert.equal(pairedBackspace("“", "”"), true);
  assert.equal(pairedBackspace("(", ")"), true);
  assert.equal(pairedBackspace("(", ")", { autoCloseBrackets: false }), false);
});
test("짝 Backspace: 줄 끝·짝 아닌 문자에서는 일반 Backspace", () => {
  assert.equal(pairedBackspace("첫째 줄", ""), false);
  assert.equal(pairedBackspace("abc", ""), false);
  assert.equal(pairedBackspace("(", ""), false);
  assert.equal(pairedBackspace("안녕", "하세요"), false);
  assert.equal(pairedBackspace("(", "]"), false);
  assert.equal(pairedBackspace("", ")"), false);
  assert.equal(pairedBackspace("“", "”", { composing: true }), false);
});
test("말줄임표: 세 번째 점에서만 변환, 붙여넣기와 꺼짐 보호", () => {
  assert.equal(inMarkdownCode('```js\nconsole.log('),true);assert.equal(inMarkdownCode('`inline '),true);assert.equal(inMarkdownCode('```\nx\n```\n일반 원고'),false);
  assert.equal(typingPlan("..", "", "", ".").insert, "……");
  assert.equal(typingPlan("..", "", "", ".", migrateTypingPreferences({ ellipsis: "…" })).insert, "…");
  assert.equal(typingPlan("..", "", "", ".", migrateTypingPreferences({ ellipsis: "" })), null);
  assert.equal(typingPlan("..", "", "", ".", { textReplacements: [] }), null);
  assert.equal(typingPlan("..", "", "", ".", { autoSymbolReplacement: false }), null);
  assert.equal(typingPlan("", "", "", "..."), null);
});
test("분량: 서식 제외, 실제 문단·빈 문단, 공백·LF와 이모지 단위 구분", () => {
  const s = manuscriptStats("**가 나**\n\n\n\n다😀");
  assert.equal(s.text, "가 나\n\n다😀");
  assert.equal(s.withoutSpaces, 4);
  assert.equal(s.withSpaces, 5);
  assert.equal(s.withLineBreaks, 7);
  assert.equal(s.lines, 3);
  assert.equal(countForRule(s, "all", "utf16"), 8);
  assert.equal(countForRule(s, "noSpace"), 5);
  assert.equal(
    normalizeWriting({
      platform: "custom",
      goal: 4200,
      rule: "all",
      unit: "utf16",
    }).goal,
    4200,
  );
});
test("태그·사용자 규칙·표지는 재시작과 도서관 동기화에 보존", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lof-writing-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const a = await new Store(path.join(temp, "a")).init(),
    b = await new Store(path.join(temp, "b")).init();
  const p = await a.createProject({
    title: "표지 작품",
    tags: ["#판타지", "일상", "판타지"],
    writing: {
      platform: "custom",
      customName: "내 규칙",
      goal: 4200,
      rule: "all",
      unit: "utf16",
    },
  });
  assert.deepEqual(p.tags, ["판타지", "일상"]);
  await assert.rejects(a.updateProject({ id: p.id, tags: ["x".repeat(41)] }));
  const png = await fs.readFile(new URL("../assets/icon.png", import.meta.url));
  const covered = await a.setCover(p.id, png);
  assert.ok(covered.cover.startsWith("cover-"));
  await b.merge(await a.snapshot());
  const reopened = await new Store(b.root).init(),
    remote = (await reopened.list()).projects[0];
  assert.equal(remote.writing.goal, 4200);
  assert.deepEqual(remote.tags, p.tags);
  assert.equal(await reopened.coverData(remote), await a.coverData(covered));
  const snapshot = await a.snapshot();
  snapshot.assets[0].data = Buffer.from("broken").toString("base64");
  await assert.rejects(b.merge(snapshot));
  await a.updateProject({ id: p.id, cover: null });
  assert.equal(await a.coverData((await a.list()).projects[0]), null);
});
