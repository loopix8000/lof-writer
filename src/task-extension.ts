import { Extension, wrappingInputRule, type JSONContent } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { requiresSource } from "../core/text.mjs";
import { isInsideJsdocComment } from "./typing-extension";

const ManuscriptTaskItem = TaskItem.extend({
  // '[ ] '만으로 변환하는 기본 규칙 대신 아래의 '- [ ]' 규칙을 사용한다.
  addInputRules() { return []; },
  addNodeView() {
    const render = this.parent?.();
    if (!render) return null;
    return (props) => {
      const nodeView = render(props);
      const checkbox = nodeView.dom instanceof HTMLElement
        ? nodeView.dom.querySelector<HTMLInputElement>('input[type="checkbox"]') : null;
      if (checkbox) {
        // 체크만 바꿀 때는 본문에 포커스를 새로 주거나 키보드를 열지 않는다.
        checkbox.addEventListener("pointerdown", (event) => event.preventDefault());
        checkbox.addEventListener("change", (event) => {
          event.stopImmediatePropagation();
          const pos = props.getPos();
          if (typeof pos !== "number") return;
          const { state, view } = props.editor;
          const node = state.doc.nodeAt(pos);
          if (!node || node.type.name !== "taskItem") return;
          if (!props.editor.isEditable) { checkbox.checked = node.attrs.checked; return; }
          view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: checkbox.checked }));
        }, true);
      }
      return nodeView;
    };
  },
}).configure({
  nested: true,
  HTMLAttributes: { "data-type": "taskItem" },
  a11y: { checkboxLabel: (node) => `완료 여부: ${node.textContent || "빈 체크 항목"}` },
});

const hasTasks = (node: JSONContent): boolean => node.type === "taskList" || !!node.content?.some(hasTasks);

function convertTaskMarker(tr: Transaction): Transaction | null {
  const { $from, empty } = tr.selection;
  const paragraph = $from.parent;
  if (!empty || paragraph.type.name !== "paragraph" || $from.marks().some(mark => mark.type.spec.code)) return null;
  if (!$from.nodeBefore?.text?.endsWith("]")) return null;
  const { taskList, taskItem } = tr.doc.type.schema.nodes;
  const parent = $from.node($from.depth - 1);
  if (parent.type.name === "taskItem") return null;
  let lineStart = 0, lineEnd = paragraph.content.size;
  paragraph.forEach((node, offset) => {
    if (node.type.name !== "hardBreak") return;
    if (offset < $from.parentOffset) lineStart = offset + node.nodeSize;
    else lineEnd = Math.min(lineEnd, offset);
  });
  const prefix = paragraph.textBetween(lineStart, $from.parentOffset, "\n", "\uFFFC");
  const inBullet = parent.type.name === "listItem" && $from.depth >= 3
    && $from.node($from.depth - 2).type.name === "bulletList";
  if (inBullet) {
    const depth = $from.depth - 2, list = $from.node(depth);
    if (list.attrs.taskMarker !== "-" || lineStart !== 0 || $from.index(depth + 1) !== 0 || !/^[ \t]*\[ \]$/.test(prefix)) return null;
    const markerStart = $from.start();
    tr.delete(markerStart, $from.pos);
    const cursor = tr.doc.resolve(markerStart), updated = cursor.node(depth), index = cursor.index(depth);
    const before = [], after = [];
    for (let i = 0; i < updated.childCount; i++) {
      if (i < index) before.push(updated.child(i));
      else if (i > index) after.push(updated.child(i));
    }
    const leading = before.length ? [updated.copy(Fragment.fromArray(before))] : [];
    const item = taskItem.create({ checked: false }, updated.child(index).content);
    const nodes = [...leading, taskList.create(null, item), ...(after.length ? [updated.copy(Fragment.fromArray(after))] : [])];
    const start = cursor.before(depth);
    tr.replaceWith(start, start + updated.nodeSize, nodes);
    return tr.setSelection(TextSelection.create(tr.doc, start + (leading[0]?.nodeSize ?? 0) + 3));
  }
  if (!/^[ \t]*-[ \t]+\[ \]$/.test(prefix)) return null;
  const leading = lineStart ? [paragraph.copy(paragraph.content.cut(0, lineStart - 1))] : [];
  const content = paragraph.copy(paragraph.content.cut($from.parentOffset, lineEnd));
  const list = taskList.create(null, taskItem.create({ checked: false }, content));
  const trailing = lineEnd < paragraph.content.size ? [paragraph.copy(paragraph.content.cut(lineEnd + 1))] : [];
  const nodes = Fragment.fromArray([...leading, list, ...trailing]);
  const index = $from.index($from.depth - 1);
  if (!parent.canReplace(index, index + 1, nodes)) return null;
  const start = $from.before();
  tr.replaceWith(start, $from.after(), nodes);
  return tr.setSelection(TextSelection.create(tr.doc, start + (leading[0]?.nodeSize ?? 0) + 3));
}

export const MarkdownTasks = Extension.create({
  name: "markdownTasks",
  priority: 110,
  addExtensions() { return [TaskList, ManuscriptTaskItem]; },
  addGlobalAttributes() {
    // '- '가 먼저 글머리 목록으로 바뀐 경우에도 사용자가 입력한 목록 기호를 구별한다.
    return [{ types: ["bulletList"], attributes: { taskMarker: { default: "-", rendered: false } } }];
  },
  addInputRules() {
    return [wrappingInputRule({
      find: text => {
        if (isInsideJsdocComment(this.editor.state)) return null;
        const match = /^[ \t]*([-+*])[ \t]$/.exec(text);
        return match ? { index: match.index, text: match[0], data: { taskMarker: match[1] } } : null;
      },
      type: this.editor.schema.nodes.bulletList,
      getAttributes: match => ({ taskMarker: match.data?.taskMarker }),
      joinPredicate: (match, node) => node.attrs.taskMarker === match.data?.taskMarker,
    })];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    const afterNativeInput = (view: EditorView, event: Event) => {
      clearTimeout(inputTimer);
      if (event instanceof InputEvent && /^history(?:Undo|Redo)$/.test(event.inputType)) return false;
      inputTimer = setTimeout(() => {
        if (view.isDestroyed || view.composing || !editor.isEditable || isInsideJsdocComment(view.state)) return;
        const tr = convertTaskMarker(closeHistory(view.state.tr));
        if (tr) view.dispatch(tr.scrollIntoView());
      }, 0);
      return false;
    };
    return [new Plugin({
      view: () => ({ destroy: () => clearTimeout(inputTimer) }),
      props: {
        handleTextInput(view, from, to, text) {
          if (view.composing || !editor.isEditable || from !== to || !text.endsWith("]") || isInsideJsdocComment(view.state)) return false;
          // 괄호 자동 완성으로 미리 넣은 ']'를 중복하지 않고 같은 입력에서 변환한다.
          const end = text === "]" && view.state.doc.textBetween(to, to + 1) === "]" ? to + 1 : to;
          const tr = closeHistory(view.state.tr).insertText(text, from, end);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          const converted = convertTaskMarker(tr);
          if (!converted) return false;
          view.dispatch(converted.scrollIntoView());
          return true;
        },
        handleDOMEvents: { input: afterNativeInput, compositionend: afterNativeInput },
        handlePaste(view, event) {
          if (!editor.isEditable || view.state.selection.$from.parent.type.spec.code || editor.isActive("code") || editor.isActive("table")) return false;
          const text = event.clipboardData?.getData("text/plain").replace(/\r\n?/g, "\n");
          if (!text || !/^\s*[-+*]\s+\[[ xX]\](?:\s|$)/m.test(text)) return false;
          const schema = view.state.schema;
          if (requiresSource(text, { tables: !!schema.nodes.table, links: !!schema.marks.link, images: !!schema.nodes.image })) return false;
          const parsed = editor.markdown?.parse(text);
          if (!parsed?.content?.length || !hasTasks(parsed)) return false;
          event.preventDefault();
          view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromJSON(schema, parsed.content), 0, 0)).scrollIntoView());
          return true;
        },
      },
    })];
  },
});
