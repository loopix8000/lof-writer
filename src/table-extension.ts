import { Extension } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { requiresSource } from "../core/text.mjs";
import { tableStart } from "../core/markdown-table.mjs";
import { changedBlocks, docIndex } from "./doc-index";

const ManuscriptTable = Table.extend({
  markdownTokenizer: { ...Table.config.markdownTokenizer!, start: tableStart },
});

// GFM 표의 셀에는 문단과 인라인 서식을 보관한다.
export const MarkdownTables = Extension.create({
  name: "markdownTables",
  addExtensions() {
    return [
      ManuscriptTable.configure({ renderWrapper: true }),
      TableRow,
      TableCell.extend({ content: "paragraph+" }),
      TableHeader.extend({ content: "paragraph+" }),
    ];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      appendTransaction(transactions, oldState, state) {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        const tr = state.tr;
        // GFM은 첫 행만 머리글이다. 행 추가·삭제 뒤에도 저장 전후의 구조를 맞춘다.
        // 바뀐 맨 위 블록 안의 표만 보고, 문단 안쪽으로는 내려가지 않는다.
        const { start, endB } = changedBlocks(oldState.doc, state.doc);
        if (start >= endB) return null;
        const index = docIndex(state.doc);
        state.doc.nodesBetween(index.starts[start], index.starts[endB], (node, pos) => {
          if (node.isTextblock) return false;
          if (node.type.name !== "table") return true;
          node.forEach((row, rowOffset, rowIndex) => {
            const type = rowIndex === 0 ? state.schema.nodes.tableHeader : state.schema.nodes.tableCell;
            row.forEach((cell, cellOffset) => {
              if (cell.type !== type)
                tr.setNodeMarkup(pos + 2 + rowOffset + cellOffset, type, cell.attrs);
            });
          });
          return false;
        });
        return tr.docChanged ? tr : null;
      },
      props: {
        handlePaste(view, event) {
          if (!editor.isEditable || view.state.selection.$from.parent.type.spec.code ||
            editor.isActive("table") || editor.isActive("code")) return false;
          const text = event.clipboardData?.getData("text/plain").replace(/\r\n?/g, "\n");
          if (!text || !text.includes("|") || requiresSource(text, { tables: true })) return false;
          const parsed = editor.markdown?.parse(text);
          const content = parsed?.content;
          if (!content?.some((node) => node.type === "table")) return false;
          event.preventDefault();
          const fragment = Fragment.fromJSON(view.state.schema, content);
          view.dispatch(view.state.tr.replaceSelection(new Slice(fragment, 0, 0)).scrollIntoView());
          return true;
        },
        handleKeyDown(view, event) {
          if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey ||
            event.altKey || event.isComposing || view.composing || !editor.isEditable) return false;
          const { $from, empty } = view.state.selection;
          // 제목 행 다음에 구분 행을 입력하고 Enter를 누르면 표로 전환한다.
          if (!empty || $from.depth !== 1 || $from.parent.type.name !== "paragraph" ||
            $from.parentOffset !== $from.parent.content.size || $from.index(0) === 0) return false;
          const header = view.state.doc.child($from.index(0) - 1);
          const delimiter = $from.parent.textContent;
          if (header.type.name !== "paragraph" || !header.textContent.includes("|") ||
            !/^[ \t|:]*-[ \t|:-]*$/.test(delimiter) || !delimiter.includes("|")) return false;
          const headerMarkdown = editor.markdown?.serialize({ type: "doc", content: [header.toJSON()] });
          if (!headerMarkdown) return false;
          const raw = `${headerMarkdown.trim()}\n${delimiter}`;
          if (requiresSource(raw, { tables: true })) return false;
          const parsed = editor.markdown?.parse(raw);
          if (parsed?.content?.length !== 1 || parsed.content[0].type !== "table") return false;
          const table = view.state.schema.nodeFromJSON(parsed.content[0]);
          const start = $from.before() - header.nodeSize;
          const tr = view.state.tr.replaceWith(start, $from.after(), table);
          tr.setSelection(TextSelection.near(tr.doc.resolve(start + 1)));
          view.dispatch(tr.scrollIntoView());
          return true;
        },
      },
    })];
  },
});
