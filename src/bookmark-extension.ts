import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Bookmark } from "./types";
import { NOTE_GUTTER } from "./note-extension";

// 원고 북마크. 본문 맨 위 단계의 문단에 붙이고, 왼쪽 여백을 눌러 넣고 뺀다.
// 붙인 자리는 편집하는 동안 문단을 따라 옮겨 가고, 저장할 때는 문단 순서와 앞부분 글로 남긴다.
export const bookmarkPluginKey = new PluginKey<DecorationSet>("lofBookmarks");
// 북마크 목록을 다시 깔 때 쓰는 표시. 이 거래는 바뀐 북마크로 저장하지 않는다.
export const BOOKMARK_LOAD = "lofBookmarkLoad";
// 왼쪽 여백에 마우스를 올린 문단. 그 문단의 글을 강조해 북마크가 붙을 자리를 보여 준다.
const hoverKey = new PluginKey<number | null>("lofBookmarkHover");

type BookmarkMeta = { set: number[] } | { toggle: number };

const markable = (node: PMNode) => node.type.name !== "horizontalRule" && node.type.name !== "table";
export const bookmarkSnippet = (node: PMNode) => node.textContent.replace(/\s+/g, " ").trim().slice(0, 80);

function mark(doc: PMNode, pos: number) {
  const node = doc.nodeAt(pos);
  return node ? [Decoration.node(pos, pos + node.nodeSize, { class: "bookmarked" }, { bookmark: true })] : [];
}

// 마우스가 문단 왼쪽 바깥(여백의 북마크 자리)에 있으면 그 문단의 위치, 아니면 -1.
function gutterBlock(view: EditorView, event: MouseEvent) {
  let el = event.target as HTMLElement | null;
  while (el && el.parentElement !== view.dom) el = el.parentElement;
  const left = el?.getBoundingClientRect().left ?? 0;
  // 리본 바깥쪽은 메모 아이콘 자리이므로 북마크로 받지 않는다.
  if (!el || event.clientX >= left || event.clientX < left - NOTE_GUTTER.to) return -1;
  let pos = -1;
  view.state.doc.forEach((node, offset) => {
    if (pos < 0 && markable(node) && view.nodeDOM(offset) === el) pos = offset;
  });
  return pos;
}
function setHover(view: EditorView, pos: number | null) {
  if (hoverKey.getState(view.state) !== pos)
    view.dispatch(view.state.tr.setMeta(hoverKey, pos).setMeta("addToHistory", false));
}

// 지금 붙어 있는 북마크를 문서 순서대로 읽는다.
export function readBookmarks(state: EditorState): Bookmark[] {
  const set = bookmarkPluginKey.getState(state);
  if (!set) return [];
  const starts = new Set(set.find().map((d) => d.from));
  const out: Bookmark[] = [];
  state.doc.forEach((node, offset, index) => {
    if (starts.has(offset)) out.push({ index, text: bookmarkSnippet(node) });
  });
  return out;
}

// 저장된 북마크를 지금 본문의 문단 위치로 바꾼다. 앞부분 글이 같은 문단 중 원래 순서에 가장 가까운 것을 고르고,
// 그런 문단이 없으면 같은 순서의 문단에 붙인다.
export function resolveBookmarks(doc: PMNode, saved: Bookmark[] = []): number[] {
  const blocks: { pos: number; text: string; ok: boolean }[] = [];
  doc.forEach((node, offset) => blocks.push({ pos: offset, text: bookmarkSnippet(node), ok: markable(node) }));
  const used = new Set<number>();
  for (const b of saved) {
    let best = -1;
    if (b.text)
      blocks.forEach((block, i) => {
        if (!block.ok || used.has(i) || block.text !== b.text) return;
        if (best < 0 || Math.abs(i - b.index) < Math.abs(best - b.index)) best = i;
      });
    if (best < 0 && blocks[b.index]?.ok && !used.has(b.index)) best = b.index;
    if (best >= 0) used.add(best);
  }
  return [...used].sort((a, b) => a - b).map((i) => blocks[i].pos);
}

export const Bookmarks = Extension.create<{ canToggle: () => boolean }>({
  name: "bookmarks",
  addOptions() {
    return { canToggle: () => true };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<DecorationSet>({
        key: bookmarkPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(bookmarkPluginKey) as BookmarkMeta | undefined;
            if (meta && "set" in meta)
              return DecorationSet.create(tr.doc, meta.set.flatMap((pos) => mark(tr.doc, pos)));
            set = set.map(tr.mapping, tr.doc);
            if (meta && "toggle" in meta) {
              const found = set.find(meta.toggle, meta.toggle, (spec) => spec.bookmark).filter((d) => d.from === meta.toggle);
              return found.length ? set.remove(found) : set.add(tr.doc, mark(tr.doc, meta.toggle));
            }
            return set;
          },
        },
        props: {
          decorations: (state) => bookmarkPluginKey.getState(state),
          handleDOMEvents: {
            // 문단 왼쪽 바깥(여백의 북마크 자리)을 누르면 그 문단의 북마크를 넣거나 뺀다.
            mousedown: (view, event) => {
              if (event.button !== 0 || !options.canToggle()) return false;
              const pos = gutterBlock(view, event);
              if (pos < 0) return false;
              event.preventDefault();
              view.dispatch(view.state.tr.setMeta(bookmarkPluginKey, { toggle: pos }).setMeta("addToHistory", false));
              return true;
            },
          },
        },
      }),
      new Plugin<number | null>({
        key: hoverKey,
        state: {
          init: () => null,
          apply(tr, pos) {
            const meta = tr.getMeta(hoverKey) as number | null | undefined;
            if (meta !== undefined) return meta;
            return tr.docChanged ? null : pos;
          },
        },
        props: {
          decorations(state) {
            const pos = hoverKey.getState(state),
              node = pos == null ? null : state.doc.nodeAt(pos);
            return node && pos != null
              ? DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: "bookmark-target" })])
              : null;
          },
          handleDOMEvents: {
            mousemove: (view, event) => {
              const pos = options.canToggle() ? gutterBlock(view, event) : -1;
              setHover(view, pos < 0 ? null : pos);
              return false;
            },
            mouseleave: (view) => {
              setHover(view, null);
              return false;
            },
          },
        },
      }),
    ];
  },
});
