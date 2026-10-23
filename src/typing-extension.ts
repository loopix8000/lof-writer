import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  COMMENT_CLOSE, COMMENT_OPEN, blockInfo, blockMapping, changedBlocks, commentStateAt, docIndex, eachTextblock, isHardBreak, scanComments, textPos, textblockText,
} from "./doc-index";
import { typingPlan, pairedBackspace, commentBackspace, commentPairEnter, smartClosingEnter } from "../core/typing.mjs";

export const typesettingPluginKey = new PluginKey<DecorationSet>("lofTypesetting");
const commentPluginKey = new PluginKey<DecorationSet>("lofJsdocComments");

// 주석 장식. 닫히지 않은 주석(<!-- 뒤에 -->가 없는 부분)은 칠하지 않는다.
// 주석만 있는 문단에는 조판 줄간격 대신 촘촘한 간격을 쓰도록 문단 장식을 붙인다.
function commentDecorations(doc: PMNode): DecorationSet {
  if (!docIndex(doc).tokens) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  const state = { open: false, stray: false };
  let pending: Decoration[] = [];
  doc.forEach((block, offset) => {
    if (!state.open && !blockInfo(block).tokens) return;
    eachTextblock(block, offset, (node, pos) => {
      const text = textblockText(node);
      // 주석이 걸쳐 있고, 주석 밖에 남은 글이 공백뿐인지.
      let seen = false, outside = "", last = 0;
      scanComments(text, state, (from, to, closed) => {
        seen = true;
        outside += text.slice(last, from);
        last = to;
        if (to > from) {
          const start = textPos(node, pos, from), end = textPos(node, pos, to);
          if (end > start) pending.push(Decoration.inline(start, end, { class: "jsdoc-comment" }));
        }
        if (closed) {
          decorations.push(...pending);
          pending = [];
        }
      });
      outside += text.slice(last);
      if (seen && !outside.trim() && node.type.name === "paragraph")
        (state.open ? pending : decorations).push(Decoration.node(pos, pos + node.nodeSize, { class: "comment-line" }));
    });
  });
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

const breakIndentEnabled = (opts: Record<string, any>) => !!opts.hardBreakIndent && Number(opts.indent || 0) > 0;
const breakIndent = () => {
  const span = document.createElement("span");
  span.setAttribute("data-br-indent", "");
  span.contentEditable = "false";
  return span;
};
// 강제 줄바꿈 뒤 들여쓰기 자리. 모양이 모두 같으므로 같은 key로 두어 다시 그리지 않게 한다.
function addBreakIndents(block: PMNode, pos: number, decorations: Decoration[]) {
  if (!blockInfo(block).breaks) return;
  block.descendants((node, offset) => {
    if (isHardBreak(node))
      decorations.push(Decoration.widget(pos + 1 + offset + node.nodeSize, breakIndent, { side: -1, key: "indent-br" }));
    return !node.isInline;
  });
}
function breakDecorations(doc: PMNode, opts: Record<string, any>): DecorationSet {
  if (!breakIndentEnabled(opts)) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.forEach((block, offset) => addBreakIndents(block, offset, decorations));
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

// 바뀐 블록의 장식만 새로 만들고, 나머지는 위치만 옮긴다.
function updateBreakDecorations(tr: Transaction, set: DecorationSet, opts: Record<string, any>): DecorationSet {
  if (!breakIndentEnabled(opts)) return DecorationSet.empty;
  const before = docIndex(tr.before), after = docIndex(tr.doc, tr.before);
  const changed = changedBlocks(tr.before, tr.doc);
  let next = set.map(blockMapping(before, after, changed), tr.doc);
  next = next.remove(next.find(after.starts[changed.start], after.starts[changed.endB]));
  const added: Decoration[] = [];
  for (let i = changed.start; i < changed.endB; i++) addBreakIndents(tr.doc.child(i), after.starts[i], added);
  return added.length ? next.add(tr.doc, added) : next;
}

// 주석 밖에서 주석 기호와 무관한 블록만 바뀌었으면 기존 장식의 위치만 옮긴다.
function updateCommentDecorations(tr: Transaction, set: DecorationSet): DecorationSet {
  const before = docIndex(tr.before), after = docIndex(tr.doc, tr.before);
  if (!before.tokens && !after.tokens) return DecorationSet.empty;
  const changed = changedBlocks(tr.before, tr.doc);
  const touches = (doc: PMNode, from: number, to: number) => {
    for (let i = from; i < to; i++) if (blockInfo(doc.child(i)).tokens) return true;
    return false;
  };
  if (before.open[changed.start] || touches(tr.before, changed.start, changed.endA) || touches(tr.doc, changed.start, changed.endB))
    return commentDecorations(tr.doc);
  return set.map(blockMapping(before, after, changed), tr.doc);
}

function hasUnclosedCommentBefore(doc: PMNode, pos: number): boolean {
  return commentStateAt(doc, pos).open;
}

function findEnclosingBlockComment(state: EditorState): { from: number; to: number; raw: string; cursorOffset: number } | null {
  const { from, to, $from } = state.selection;
  if (from !== to || !$from.parent.isTextblock) return null;
  let charOffset = 0;
  const charToPos: number[] = [];
  let text = "";
  const blockPos = $from.before();
  $from.parent.forEach((child: any, offset: number) => {
    const childPos = blockPos + 1 + offset;
    if (child.isText && child.text) {
      for (let i = 0; i < child.text.length; i++) {
        if (childPos + i === from) charOffset = text.length + i;
        charToPos.push(childPos + i);
      }
      text += child.text;
    } else {
      if (childPos === from) charOffset = text.length;
      charToPos.push(childPos);
      text += child.type.name === "hardBreak" ? "\n" : "\uFFFC";
    }
  });
  if (from === blockPos + $from.parent.nodeSize - 1) charOffset = text.length;
  charToPos.push(blockPos + $from.parent.nodeSize - 1);
  if (!text.includes(COMMENT_OPEN)) return null;
  for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
    const mStart = match.index ?? 0;
    const mEnd = mStart + match[0].length;
    if (mStart <= charOffset && charOffset <= mEnd) {
      return {
        from: charToPos[mStart],
        to: charToPos[mEnd],
        raw: match[0],
        cursorOffset: charOffset - mStart,
      };
    }
  }
  return null;
}

export function isInsideJsdocComment(state: EditorState): boolean {
  const { from, to } = state.selection;
  if (from !== to) {
    const selected = state.doc.textBetween(from, to, "\n");
    if (/^\s*<!--[\s\S]*-->\s*$/.test(selected)) return true;
  }
  return !!findEnclosingBlockComment(state) || hasUnclosedCommentBefore(state.doc, from);
}

export function toggleJsdocComment(view: EditorView): boolean {
  if (!view.editable) return false;
  const { state } = view;
  const { from, to } = state.selection;
  let tr = closeHistory(state.tr);

  if (from === to) {
    const enclosing = findEnclosingBlockComment(state);
    if (enclosing) {
      const openLen = enclosing.raw.match(/^<!--\s?/)?.[0].length ?? COMMENT_OPEN.length;
      const closeLen = enclosing.raw.match(/\s?-->$/)?.[0].length ?? COMMENT_CLOSE.length;
      const inner = enclosing.raw.slice(openLen, Math.max(openLen, enclosing.raw.length - closeLen));
      tr = tr.insertText(inner, enclosing.from, enclosing.to);
      const nextCursor = enclosing.from + Math.max(0, Math.min(inner.length, enclosing.cursorOffset - openLen));
      tr = tr.setSelection(TextSelection.create(tr.doc, nextCursor));
      view.dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    }
    tr = tr.insertText(`${COMMENT_OPEN}  ${COMMENT_CLOSE}`, from, to);
    tr = tr.setSelection(TextSelection.create(tr.doc, from + COMMENT_OPEN.length + 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }

  const selected = state.doc.textBetween(from, to, "\n");
  if (/^\s*<!--[\s\S]*-->\s*$/.test(selected)) {
    const unwrapped = selected.replace(/^(\s*)<!--\s?/, "$1").replace(/\s?-->(\s*)$/, "$1");
    tr = tr.insertText(unwrapped, from, to);
    tr = tr.setSelection(TextSelection.create(tr.doc, from, from + unwrapped.length));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }

  const open = `${COMMENT_OPEN} `;
  tr = tr.insertText(` ${COMMENT_CLOSE}`, to).insertText(open, from);
  tr = tr.setSelection(TextSelection.create(tr.doc, from + open.length, to + open.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export const TypingAssist = Extension.create<{
  getOptions: () => Record<string, any>;
}>({
  name: "typingAssist",
  addOptions() {
    return { getOptions: (): Record<string, any> => ({}) };
  },
  addProseMirrorPlugins() {
    const getOptions = this.options.getOptions;
    return [
      new Plugin({
        key: typesettingPluginKey,
        state: {
          init(_, { doc }) {
            return breakDecorations(doc, getOptions());
          },
          apply(tr, old) {
            if (tr.getMeta(typesettingPluginKey)) return breakDecorations(tr.doc, getOptions());
            return tr.docChanged ? updateBreakDecorations(tr, old, getOptions()) : old;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleTextInput(view, from, to, text) {
            if (view.composing) return false;
            const resolved = view.state.doc.resolve(from);
            const inComment = hasUnclosedCommentBefore(view.state.doc, from);
            const opts: Record<string, any> = {
              ...getOptions(),
              inComment,
              inCode:
                !!resolved.parent.type.spec.code ||
                resolved.marks().some((m) => m.type.name === "code"),
            };
            const before = resolved.parent.textBetween(
                0,
                resolved.parentOffset,
                "\n",
              ),
              after = view.state.doc
                .resolve(to)
                .parent.textBetween(
                  view.state.doc.resolve(to).parentOffset,
                  view.state.doc.resolve(to).parent.content.size,
                  "\n",
                );
            // 주석 안에서 줄 시작에 '* '를 입력할 때 글머리 목록으로 바뀌지 않게 한다.
            if (inComment && text === " " && from === to && /^\s*\*+$/.test(before)) {
              const tr = closeHistory(view.state.tr).insertText(" ", from, to);
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            // 구분선 단락 자동 전환: 줄 시작에서 -----, ——-, *** 입력 시 구분선 블록으로 변환
            const candidateLine = before + text;
            if (
              opts.autoDividerReplacement !== false &&
              !opts.inCode &&
              !inComment &&
              from === to &&
              after === "" &&
              resolved.parent.type.name === "paragraph" &&
              /^(?:----|——)-$|^\*{3}$/.test(candidateLine) &&
              view.state.schema.nodes.horizontalRule
            ) {
              const blockStart = resolved.before();
              const blockEnd = resolved.after();
              const hrNode = view.state.schema.nodes.horizontalRule.create();
              const pNode = view.state.schema.nodes.paragraph.create();
              let tr = closeHistory(view.state.tr).replaceWith(
                blockStart,
                blockEnd,
                [hrNode, pNode],
              );
              const nextCursor = Math.min(
                tr.doc.content.size,
                blockStart + hrNode.nodeSize + 1,
              );
              tr = tr.setSelection(TextSelection.create(tr.doc, nextCursor));
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            const selected = view.state.doc.textBetween(from, to, "\n");
            const plan = typingPlan(before, selected, after, text, opts);
            if (!plan) {
              // 주석에서는 Markdown 목록·구분선 입력 규칙도 실행하지 않는다.
              if (!inComment || opts.inCode) return false;
              view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
              return true;
            }
            let tr = closeHistory(view.state.tr);
            if (plan.skip)
              tr = tr.setSelection(
                TextSelection.create(tr.doc, from + plan.skip),
              );
            else if (plan.wrap) {
              tr = tr.insertText(plan.close, to).insertText(plan.open, from);
              tr = tr.setSelection(
                TextSelection.create(
                  tr.doc,
                  from + plan.open.length,
                  to + plan.open.length,
                ),
              );
            } else {
              const start = from - plan.deleteBefore;
              const end = to + (plan.deleteAfter || 0);
              tr = tr.insertText(plan.insert, start, end);
              tr = tr.setSelection(
                TextSelection.create(tr.doc, start + plan.caret),
              );
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          },
          handleKeyDown(view, event) {
            if (view.composing) return false;
            if (
              (event.ctrlKey || event.metaKey) &&
              !event.altKey &&
              !event.shiftKey &&
              (event.key === "/" || event.code === "Slash")
            ) {
              if (toggleJsdocComment(view)) {
                event.preventDefault();
                return true;
              }
              return false;
            }
            if (
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              event.shiftKey ||
              !view.state.selection.empty
            )
              return false;
            const { $from } = view.state.selection,
              position = $from.pos;
            const opts = {
              ...getOptions(),
              inCode:
                !!$from.parent.type.spec.code ||
                $from.marks().some((m) => m.type.name === "code"),
            };
            const before = $from.parent.textBetween(0, $from.parentOffset);
            const after = $from.parent.textBetween(
              $from.parentOffset,
              $from.parent.content.size,
            );
            // 주석 짝 사이에서 공백을 정리하고 세 문단으로 나눈 뒤 가운데 줄로 옮긴다.
            if (
              event.key === "Enter" &&
              $from.depth === 1 &&
              $from.parent.type.name === "paragraph" &&
              commentPairEnter(before, after, opts)
            ) {
              const start = position - (before.match(/[ \t]*$/)?.[0].length ?? 0);
              const end = position + (after.match(/^[ \t]*/)?.[0].length ?? 0);
              let tr = closeHistory(view.state.tr).delete(start, end).split(start).split(start + 2);
              tr = tr.setSelection(TextSelection.create(tr.doc, start + 2));
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            if (
              event.key === "Enter" &&
              $from.parent.type.name === "paragraph" &&
              smartClosingEnter(before, after, opts)
            ) {
              const pNode = view.state.schema.nodes.paragraph.create();
              const blockEnd = $from.after();
              let tr = closeHistory(view.state.tr).insert(blockEnd, pNode);
              tr = tr.setSelection(TextSelection.create(tr.doc, blockEnd + 1));
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            if (event.key !== "Backspace") return false;
            const commentPair = commentBackspace(before, after, opts);
            const padding = commentPair && before.endsWith(`${COMMENT_OPEN} `) ? 1 : 0;
            const closer = commentPair ? COMMENT_CLOSE.length + padding : pairedBackspace(before, after, opts) ? 1 : 0;
            if (!closer) return false;
            view.dispatch(
              closeHistory(view.state.tr).delete(position - 1 - padding, position + closer),
            );
            return true;
          },
        },
      }),
      new Plugin<DecorationSet>({
        key: commentPluginKey,
        state: {
          init: (_, { doc }) => commentDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? updateCommentDecorations(tr, old) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
