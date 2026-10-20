import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NoteMark } from "./note-links";
import { blockMapping, changedBlocks, docIndex } from "./doc-index";

// 원고의 메모 표시. 퀵 노트가 인용한 문장이 있는 맨 위 단계 문단에 표시를 달고,
// 왼쪽 여백(북마크 리본 바깥)의 메모 아이콘을 누르면 그 메모를 연다.
// hits는 메모마다 인용 문장이 처음 나오는 맨 위 블록 번호(없으면 -1)다.
type NoteState = { list: NoteMark[]; needles: string[]; hits: Int32Array; set: DecorationSet };
export const notePluginKey = new PluginKey<NoteState>("lofNotes");

// 메모 아이콘 자리: 문단 왼쪽 끝에서 이만큼 바깥(북마크 리본은 그 안쪽에 있다).
export const NOTE_GUTTER = { from: 64, to: 40 };

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const blockTexts = new WeakMap<PMNode, string>();
function blockText(node: PMNode) {
  let text = blockTexts.get(node);
  if (text === undefined) blockTexts.set(node, (text = squash(node.textContent)));
  return text;
}
function findBlock(doc: PMNode, needle: string, from: number, to = doc.childCount) {
  if (!needle) return -1;
  for (let i = from; i < to; i++) if (blockText(doc.child(i)).includes(needle)) return i;
  return -1;
}

function noteSet(doc: PMNode, list: NoteMark[], hits: Int32Array) {
  const index = docIndex(doc), byBlock = new Map<number, NoteMark[]>();
  list.forEach((note, n) => {
    if (hits[n] >= 0) byBlock.set(hits[n], [...(byBlock.get(hits[n]) || []), note]);
  });
  return DecorationSet.create(
    doc,
    [...byBlock].map(([i, notes]) => {
      const pos = index.starts[i];
      return Decoration.node(pos, pos + doc.child(i).nodeSize, { class: "noted" }, { notes });
    }),
  );
}

function decorate(doc: PMNode, list: NoteMark[]): NoteState {
  const needles = list.map((note) => squash(note.text));
  const hits = Int32Array.from(needles, (needle) => findBlock(doc, needle, 0));
  return { list, needles, hits, set: list.length ? noteSet(doc, list, hits) : DecorationSet.empty };
}

// 바뀐 블록 앞에서 이미 찾은 메모는 그대로 두고, 나머지는 바뀐 블록(필요하면 그 뒤)에서만 다시 찾는다.
function update(tr: Transaction, value: NoteState): NoteState {
  if (!value.list.length) return value;
  const changed = changedBlocks(tr.before, tr.doc), shift = changed.endB - changed.endA;
  const hits = new Int32Array(value.hits);
  let rebuild = false;
  value.needles.forEach((needle, n) => {
    const hit = value.hits[n];
    if (hit >= 0 && hit < changed.start) return;
    let next = findBlock(tr.doc, needle, changed.start, changed.endB);
    // 바뀐 블록에 없으면: 원래 뒤쪽에서 찾았던 메모는 그 블록 그대로, 바뀐 블록에서 찾았던 메모는 뒤쪽을 다시 찾는다.
    if (next < 0 && hit >= changed.endA) next = hit + shift;
    else if (next < 0 && hit >= 0) next = findBlock(tr.doc, needle, changed.endB);
    hits[n] = next;
    if ((hit >= changed.start && hit < changed.endA) || (next >= changed.start && next < changed.endB) || (hit < 0) !== (next < 0))
      rebuild = true;
  });
  const set = rebuild
    ? noteSet(tr.doc, value.list, hits)
    : value.set.map(blockMapping(docIndex(tr.before), docIndex(tr.doc, tr.before), changed), tr.doc);
  return { ...value, hits, set };
}

// 마우스가 문단 왼쪽의 메모 아이콘 위에 있으면 그 문단의 메모 목록.
function gutterNotes(view: EditorView, event: MouseEvent): NoteMark[] | null {
  let el = event.target as HTMLElement | null;
  while (el && el.parentElement !== view.dom) el = el.parentElement;
  if (!el?.classList.contains("noted")) return null;
  const left = el.getBoundingClientRect().left;
  if (event.clientX < left - NOTE_GUTTER.from || event.clientX >= left - NOTE_GUTTER.to) return null;
  const inside = view.state.doc.resolve(view.posAtDOM(el, 0));
  const pos = inside.depth ? inside.before(1) : inside.pos;
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
          init: (_, { doc }) => decorate(doc, []),
          apply(tr, value) {
            const list = tr.getMeta(notePluginKey) as NoteMark[] | undefined;
            if (list) return decorate(tr.doc, list);
            return tr.docChanged ? update(tr, value) : value;
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
