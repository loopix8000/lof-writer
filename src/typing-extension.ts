import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { typingPlan, pairedBackspace, smartClosingEnter } from "../core/typing.mjs";

export const typesettingPluginKey = new PluginKey("lofTypesetting");

function buildTypesettingDecorations(doc: any, opts: Record<string, any>) {
  const brIndent = !!opts.hardBreakIndent && Number(opts.indent || 0) > 0;
  if (!brIndent) return DecorationSet.empty;

  const decorations: Decoration[] = [];
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
  return DecorationSet.create(doc, decorations);
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
            // 구분선 단락 자동 전환: 줄 시작에서 -----, ——-, *** 입력 시 구분선 블록으로 변환
            const candidateLine = before + text;
            if (
              opts.autoDividerReplacement !== false &&
              !opts.composing &&
              !opts.inCode &&
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

