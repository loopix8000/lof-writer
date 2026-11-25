import { createDocument, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { textblockText, textPos } from "./doc-index";

// 블록 i의 시작 위치(블록 앞). i가 블록 수와 같으면 문서 내용의 끝이다.
function blockStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// 같은 종류의 문단 하나가 바뀌었을 때, 앞뒤로 같은 글자를 뺀 범위만 바꿔 본다.
// 마크만 달라진 경우처럼 글자 비교로는 잡히지 않는 변경이면 false를 돌려주고 블록 단위로 바꾼다.
function replaceTextRange(tr: Transaction, a: PMNode, posA: number, b: PMNode, posB: number, next: PMNode): boolean {
  const textA = textblockText(a), textB = textblockText(b);
  if (textA === textB) return false;
  const min = Math.min(textA.length, textB.length);
  let start = 0;
  while (start < min && textA.charCodeAt(start) === textB.charCodeAt(start)) start++;
  // 서로게이트 쌍 가운데를 자르지 않는다.
  if (start > 0 && isHighSurrogate(textA.charCodeAt(start - 1))) start--;
  let endA = textA.length, endB = textB.length;
  while (endA > start && endB > start && textA.charCodeAt(endA - 1) === textB.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < textA.length && isLowSurrogate(textA.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  tr.replace(textPos(a, posA, start), textPos(a, posA, endA), next.slice(textPos(b, posB, start), textPos(b, posB, endB)));
  return true;
}

// 밖에서 바뀐 본문을 편집기에 반영한다. 문서 전체를 갈아 끼우면 커서가 문서 끝으로 밀려나고 화면도 튀므로,
// 앞뒤로 같은 블록은 그대로 두고 달라진 구간만 바꾼다. 바뀌지 않은 자리의 커서·선택은 그대로 남는다.
// 반영할 차이가 없으면 false를 돌려준다.
export function replaceExternalContent(editor: Editor, markdown: string): boolean {
  const { state } = editor;
  const parsed = editor.markdown ? editor.markdown.parse(markdown) : markdown;
  let next = createDocument(parsed, editor.schema, {}, { errorOnInvalidContent: editor.options.enableContentCheck });
  if (next.type !== state.schema.topNodeType) next = state.schema.topNodeType.create(null, next);
  if (next.childCount === 0) next = state.schema.topNodeType.createAndFill() ?? next;
  const old = state.doc;
  if (old.eq(next)) return false;
  const countA = old.childCount, countB = next.childCount, min = Math.min(countA, countB);
  let start = 0;
  while (start < min && old.child(start).eq(next.child(start))) start++;
  let endA = countA, endB = countB;
  while (endA > start && endB > start && old.child(endA - 1).eq(next.child(endB - 1))) {
    endA--;
    endB--;
  }
  const posA = blockStart(old, start), posB = blockStart(next, start);
  const attempts: ((tr: Transaction) => boolean)[] = [];
  if (endA - start === 1 && endB - start === 1) {
    const a = old.child(start), b = next.child(start);
    if (a.isTextblock && b.isTextblock && a.sameMarkup(b))
      attempts.push((tr) => replaceTextRange(tr, a, posA, b, posB, next));
  }
  attempts.push((tr) => {
    tr.replace(posA, blockStart(old, endA), next.slice(posB, blockStart(next, endB)));
    return true;
  });
  // 좁혀서 바꾼 결과가 새 본문과 다르면 더 넓은 범위로 다시 시도한다.
  for (const attempt of attempts) {
    try {
      const tr = closeHistory(state.tr);
      if (attempt(tr) && tr.doc.eq(next)) {
        editor.view.dispatch(tr.setMeta("preventUpdate", true));
        return true;
      }
    } catch {
      // 구조가 맞지 않아 바꿔 넣지 못하면 아래에서 전체를 바꾼다.
    }
  }
  // 전체를 바꿀 때도 커서는 원래 자리 근처에 둔다.
  const { anchor, head } = state.selection;
  const tr = closeHistory(state.tr).replaceWith(0, old.content.size, next.content);
  const size = tr.doc.content.size;
  tr.setSelection(TextSelection.between(tr.doc.resolve(Math.min(anchor, size)), tr.doc.resolve(Math.min(head, size))));
  editor.view.dispatch(tr.setMeta("preventUpdate", true));
  return true;
}
