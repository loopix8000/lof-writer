import test from "node:test";
import assert from "node:assert/strict";
import { Table } from "@tiptap/extension-table";
import { marked } from "marked";
import { tableStart } from "../core/markdown-table.mjs";
import { manuscriptStats, requiresSource } from "../core/text.mjs";

test("표 시작 검사는 기본 표 파서와 같은 결과를 반환한다", () => {
  const original = Table.config.markdownTokenizer.start;
  for (const source of [
    "", "일반 원고", "첫 문단\n\n다음 문단", "제목\n---", "| 제목 | 값 |\n| --- | :---: |\n| 가 | 나 |",
    "제목 | 값\n--- | ---\n가 | 나", "| 제목 |\n구분선 아님", "| 제목 |\n:---|\n내용", "일반 문단\n---|",
    "| 제목 | 값 |\r\n| --- | --- |\r\n| 가 | 나 |", "| `가|나` | 값 |\n| --- | --- |\n| 내용 | 값 |",
  ]) assert.equal(tableStart(source), original(source), JSON.stringify(source));
});

test("표 시작 검사에서 뒤쪽 수만 줄을 분리하지 않는다", () => {
  let limit;
  const source = { split(separator, requestedLimit) {
    assert.equal(separator, "\n"); limit = requestedLimit;
    return "일반 원고\n다음 원고".split(separator, requestedLimit);
  } };
  assert.equal(tableStart(source), -1);
  assert.equal(limit, 2);
});

test("편집기 확장이 전역 marked에 등록되어도 통계·원문 보호 파서는 영향을 받지 않는다", () => {
  const previous = marked.defaults;
  try {
    marked.use({ extensions: [{ name: "진단용확장", level: "block", start() { throw Error("전역 확장이 통계 파서로 유입되었습니다."); }, tokenizer() {} }] });
    assert.equal(manuscriptStats("통계 격리 확인\n\n일반 원고입니다.").utf16WithoutSpaces, 14);
    assert.equal(requiresSource("보호 검사 격리 확인\n\n일반 원고입니다."), false);
    assert.equal(requiresSource("보호 검사 격리 확인\n\n![그림](picture.png)"), true);
  } finally { marked.setOptions(previous); }
});
