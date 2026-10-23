import { Extension, type JSONContent } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { requiresSource } from "../core/text.mjs";

const ManuscriptTaskItem = TaskItem.extend({
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
  a11y: { checkboxLabel: (node) => `완료 여부: ${node.textContent || "빈 체크 항목"}` },
});

const hasTasks = (node: JSONContent): boolean => node.type === "taskList" || !!node.content?.some(hasTasks);

export const MarkdownTasks = Extension.create({
  name: "markdownTasks",
  addExtensions() { return [TaskList, ManuscriptTaskItem]; },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      props: {
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
