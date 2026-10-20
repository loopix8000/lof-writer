import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { typingPlan, pairedBackspace, smartClosingEnter } from "../core/typing.mjs";

export const typesettingPluginKey = new PluginKey("lofTypesetting");

function addJsdocDecorations(doc: any, decorations: Decoration[]) {
  let hasOpen = false;
  doc.descendants((node: any) => {
    if (hasOpen) return false;
    if (node.isText && node.text?.includes("/*")) {
      hasOpen = true;
      return false;
    }
    return true;
  });
  if (!hasOpen) return;

  const blocks: {
    text: string;
    charToPos: number[];
  }[] = [];
  const blockOffsets: { start: number; end: number; blockIndex: number }[] = [];
  let fullText = "";

  doc.descendants((node: any, pos: number) => {
    if (!node.isTextblock) return true;
    const charToPos: number[] = [];
    let text = "";
    node.forEach((child: any, offset: number) => {
      const childPos = pos + 1 + offset;
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) {
          charToPos.push(childPos + i);
        }
        text += child.text;
      } else {
        charToPos.push(childPos);
        text += child.type.name === "hardBreak" ? "\n" : "\uFFFC";
      }
    });
    charToPos.push(pos + node.nodeSize - 1);
    const start = fullText.length;
    fullText += text + "\n";
    const end = fullText.length - 1;
    const blockIndex = blocks.length;
    blocks.push({ text, charToPos });
    blockOffsets.push({ start, end, blockIndex });
    return false;
  });

  const commentRe = /\/\*[\s\S]*?\*\//g;
  for (const match of fullText.matchAll(commentRe)) {
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    for (const bo of blockOffsets) {
      if (bo.end <= matchStart) continue;
      if (bo.start >= matchEnd) break;
      const block = blocks[bo.blockIndex];
      const localStart = Math.max(0, matchStart - bo.start);
      const localEnd = Math.min(block.text.length, matchEnd - bo.start);
      if (localEnd > localStart) {
        const fromPos = block.charToPos[localStart];
        const toPos = block.charToPos[localEnd];
        if (toPos > fromPos) {
          decorations.push(Decoration.inline(fromPos, toPos, { class: "jsdoc-comment" }));
        }
      }
    }
  }
}

function buildTypesettingDecorations(doc: any, opts: Record<string, any>) {
  const brIndent = !!opts.hardBreakIndent && Number(opts.indent || 0) > 0;
  const decorations: Decoration[] = [];

  if (brIndent) {
    doc.descendants((node: any, pos: number) => {
      if (node.type.name === "hardBreak" || node.type.name === "hard_break") {
        decorations.push(
          Decoration.widget(
            pos + node.nodeSize,
            () => {
              const span = document.createElement("span");
              span.setAttribute("data-br-indent", "");
              span.contentEditable = "false";
              return span;
            },
            { side: -1, key: `indent-br-${pos}` },
          ),
        );
      }
    });
  }

  addJsdocDecorations(doc, decorations);
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function hasUnclosedCommentBefore(doc: any, pos: number): boolean {
  const prefix = doc.textBetween(0, pos, "\n");
  if (!prefix.includes("/*")) return false;
  const rest = prefix.replace(/\/\*[\s\S]*?\*\//g, "");
  return rest.includes("/*");
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
  if (!text.includes("/*")) return null;
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
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
    if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(selected)) return true;
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
      const openLen = enclosing.raw.match(/^\/\*+\s?/)?.[0].length ?? 2;
      const closeLen = enclosing.raw.match(/\s?\*+\/$/)?.[0].length ?? 2;
      const inner = enclosing.raw.slice(openLen, Math.max(openLen, enclosing.raw.length - closeLen));
      tr = tr.insertText(inner, enclosing.from, enclosing.to);
      const nextCursor = enclosing.from + Math.max(0, Math.min(inner.length, enclosing.cursorOffset - openLen));
      tr = tr.setSelection(TextSelection.create(tr.doc, nextCursor));
      view.dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    }
    tr = tr.insertText("/**  */", from, to);
    tr = tr.setSelection(TextSelection.create(tr.doc, from + 4));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }

  const selected = state.doc.textBetween(from, to, "\n");
  if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(selected)) {
    const unwrapped = selected.replace(/^(\s*)\/\*+\s?/, "$1").replace(/\s?\*+\/(\s*)$/, "$1");
    tr = tr.insertText(unwrapped, from, to);
    tr = tr.setSelection(TextSelection.create(tr.doc, from, from + unwrapped.length));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }

  tr = tr.insertText(" */", to).insertText("/** ", from);
  tr = tr.setSelection(TextSelection.create(tr.doc, from + 4, to + 4));
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
            return buildTypesettingDecorations(doc, getOptions());
          },
          apply(tr, old, _, newState) {
            if (tr.docChanged || tr.getMeta(typesettingPluginKey)) {
              return buildTypesettingDecorations(newState.doc, getOptions());
            }
            return old;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleTextInput(view, from, to, text) {
            const resolved = view.state.doc.resolve(from);
            const inComment = hasUnclosedCommentBefore(view.state.doc, from);
            const opts: Record<string, any> = {
              ...getOptions(),
              composing: view.composing,
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
            // JSDoc 블록 주석 안에서 줄 시작에 '* '를 입력할 때 글머리 목록으로 바뀌지 않게 한다.
            if (inComment && text === " " && from === to && /^\s*\*+$/.test(before)) {
              const tr = closeHistory(view.state.tr).insertText(" ", from, to);
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            // 구분선 단락 자동 전환: 줄 시작에서 -----, ——-, *** 입력 시 구분선 블록으로 변환
            const candidateLine = before + text;
            if (
              opts.autoDividerReplacement !== false &&
              !opts.composing &&
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
            if (!plan) return false;
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
              composing: view.composing || event.isComposing,
              inCode:
                !!$from.parent.type.spec.code ||
                $from.marks().some((m) => m.type.name === "code"),
            };
            const before = $from.parent.textBetween(0, $from.parentOffset);
            const after = $from.parent.textBetween(
              $from.parentOffset,
              $from.parent.content.size,
            );
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
            if (!pairedBackspace(before, after, opts)) return false;
            view.dispatch(
              closeHistory(view.state.tr).delete(position - 1, position + 1),
            );
            return true;
          },
        },
      }),
    ];
  },
});
