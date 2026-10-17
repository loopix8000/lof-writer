import type { Node as PMNode } from "@tiptap/pm/model";
import { countForWriting } from "../core/text.mjs";
import type { WritingRules } from "./types";

export type ManuscriptCounts = {
  withoutSpaces: number; withSpaces: number; withLineBreaks: number;
  utf16WithoutSpaces: number; utf16WithSpaces: number; utf16WithLineBreaks: number;
  utf8Bytes: number; lines: number; paragraphs: number; platformCharacters: number;
};
export const emptyCounts = (): ManuscriptCounts => ({
  withoutSpaces: 0, withSpaces: 0, withLineBreaks: 0,
  utf16WithoutSpaces: 0, utf16WithSpaces: 0, utf16WithLineBreaks: 0,
  utf8Bytes: 0, lines: 0, paragraphs: 0, platformCharacters: 0,
});
export function addCounts(base: ManuscriptCounts, delta: ManuscriptCounts): ManuscriptCounts {
  const result = { ...base };
  for (const key of Object.keys(result) as (keyof ManuscriptCounts)[]) result[key] = Math.max(0, base[key] + delta[key]);
  return result;
}
export function textCounts(raw: string, rules: WritingRules): ManuscriptCounts {
  const text = raw
    .replace(/\r\n?|\u2028|\u2029/g, "\n").replace(/\u00a0/g, " ");
  const noSpace = text.replace(/\s/g, ""), spaces = text.replace(/[\r\n]/g, "");
  return {
    withoutSpaces: [...noSpace].length, withSpaces: [...spaces].length, withLineBreaks: [...text].length,
    utf16WithoutSpaces: noSpace.length, utf16WithSpaces: spaces.length, utf16WithLineBreaks: text.length,
    utf8Bytes: new TextEncoder().encode(text).length, lines: text ? text.split("\n").length : 0,
    paragraphs: text ? text.split(/\n+/).filter(line => line.trim()).length : 0,
    platformCharacters: countForWriting({ text }, rules),
  };
}
function blockCounts(node: PMNode, rules: WritingRules): ManuscriptCounts {
  return textCounts(node.textBetween(0, node.content.size, "\n", (leaf) => leaf.type.name === "hardBreak" ? "\n" : ""), rules);
}
// 일반 입력은 바뀐 문단만 센다. 구조가 바뀐 편집은 백그라운드 전체 계산에 맡긴다.
export function paragraphCountDelta(before: PMNode, after: PMNode, rules: WritingRules): ManuscriptCounts | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return emptyCounts();
  const end = before.content.findDiffEnd(after.content);
  if (!end) return null;
  const oldStart = before.resolve(start), oldEnd = before.resolve(Math.max(start, end.a));
  const newStart = after.resolve(start), newEnd = after.resolve(Math.max(start, end.b));
  if (!oldStart.sameParent(oldEnd) || !newStart.sameParent(newEnd) ||
      !oldStart.parent.isTextblock || !newStart.parent.isTextblock || oldStart.parent.type !== newStart.parent.type)
    return null;
  const oldCounts = blockCounts(oldStart.parent, rules), newCounts = blockCounts(newStart.parent, rules);
  for (const key of Object.keys(newCounts) as (keyof ManuscriptCounts)[]) newCounts[key] -= oldCounts[key];
  return newCounts;
}
