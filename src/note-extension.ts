import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NoteMark } from "./note-links";

// 원고의 메모 표시. 퀵 노트가 인용한 문장이 있는 맨 위 단계 문단에 표시를 달고,
// 왼쪽 여백(북마크 리본 바깥)의 메모 아이콘을 누르면 그 메모를 연다.
export const notePluginKey = new PluginKey<{ list: NoteMark[]; set: DecorationSet }>("lofNotes");

// 메모 아이콘 자리: 문단 왼쪽 끝에서 이만큼 바깥(북마크 리본은 그 안쪽에 있다).
export const NOTE_GUTTER = { from: 64, to: 40 };

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

function decorate(doc: PMNode, list: NoteMark[]) {
  const blocks: { pos: number; node: PMNode; text: string }[] = [];
  doc.forEach((node, pos) => blocks.push({ pos, node, text: squash(node.textContent) }));
  const byBlock = new Map<number, NoteMark[]>();
  for (const note of list) {
    const text = squash(note.text);
    const hit = text && blocks.find((b) => b.text.includes(text));
    if (hit) byBlock.set(hit.pos, [...(byBlock.get(hit.pos) || []), note]);
  }
  return DecorationSet.create(
    doc,
    [...byBlock].map(([pos, notes]) => {
      const node = doc.nodeAt(pos)!;
      return Decoration.node(pos, pos + node.nodeSize, { class: "noted" }, { notes });
    }),
  );
}

// 마우스가 문단 왼쪽의 메모 아이콘 위에 있으면 그 문단의 메모 목록.
function gutterNotes(view: EditorView, event: MouseEvent): NoteMark[] | null {
  let el = event.target as HTMLElement | null;
  while (el && el.parentElement !== view.dom) el = el.parentElement;
  if (!el?.classList.contains("noted")) return null;
  const left = el.getBoundingClientRect().left;
  if (event.clientX < left - NOTE_GUTTER.from || event.clientX >= left - NOTE_GUTTER.to) return null;
  let pos = -1;
  view.state.doc.forEach((_node, offset) => {
    if (pos < 0 && view.nodeDOM(offset) === el) pos = offset;
  });
  if (pos < 0) return null;
  const found = notePluginKey.getState(view.state)?.set.find(pos, pos + 1).find((d) => d.from === pos);
  return (found?.spec.notes as NoteMark[]) ?? null;
}

export const NoteMarks = Extension.create<{ onOpen: (notes: NoteMark[], event: MouseEvent) => void }>({
  name: "noteMarks",
  addOptions() {
    return { onOpen: () => {} };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: notePluginKey,
        state: {
          init: () => ({ list: [] as NoteMark[], set: DecorationSet.empty }),
          apply(tr, value) {
            const list = tr.getMeta(notePluginKey) as NoteMark[] | undefined;
            if (list) return { list, set: decorate(tr.doc, list) };
            return tr.docChanged ? { list: value.list, set: decorate(tr.doc, value.list) } : value;
          },
        },
        props: {
          decorations: (state) => notePluginKey.getState(state)?.set,
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (event.button !== 0) return false;
              const notes = gutterNotes(view, event);
              if (!notes) return false;
              event.preventDefault();
              options.onOpen(notes, event);
              return true;
            },
          },
        },
      }),
    ];
  },
});
