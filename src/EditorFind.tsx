import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { ArrowDown, ArrowUp, Replace, ReplaceAll, Search, TextSelect, X } from "lucide-react";
import type { SourceEditorHandle } from "./SourceEditor";

export type FindRange = { from: number; to: number };
type FindMarks = { hits: FindRange[]; active: number };
const findKey = new PluginKey<DecorationSet>("lofFind");

// 정규식 문자는 그대로 찾고, 대소문자 비교로 글자 길이가 바뀌어도 원래 위치를 쓴다.
export function findText(text: string, query: string, caseSensitive: boolean, offset = 0): FindRange[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
  return Array.from(text.matchAll(pattern), match => ({ from: offset + match.index!, to: offset + match.index! + match[0].length }));
}

function findInEditor(editor: Editor, query: string, caseSensitive: boolean): FindRange[] {
  const found: FindRange[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    found.push(...findText(node.textBetween(0, node.content.size, "", "\ufffc"), query, caseSensitive, pos + 1));
    return false;
  });
  return found;
}

export const FindHighlights = Extension.create({
  name: "findHighlights",
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: findKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, marks) {
          const value = tr.getMeta(findKey) as FindMarks | undefined;
          if (!value) return tr.docChanged ? marks.map(tr.mapping, tr.doc) : marks;
          return DecorationSet.create(tr.doc, value.hits.map((hit, index) => Decoration.inline(hit.from, hit.to, {
            class: `editor-find-hit${index === value.active ? " current" : ""}`,
          })));
        },
      },
      props: { decorations: state => findKey.getState(state) },
    })];
  },
});

export default function EditorFind({ editor, sourceRef, body, enabled, editable = false }: {
  editor?: Editor | null;
  sourceRef?: RefObject<SourceEditorHandle | null>;
  body?: string;
  enabled: boolean;
  editable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [active, setActive] = useState(0);
  const [revision, setRevision] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const revealRequested = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const focusInput = () => { input.current?.focus({ preventScroll: true }); input.current?.select(); };
  const focusEditor = () => {
    if (sourceRef) sourceRef.current?.view?.focus();
    else if (editor && !editor.isDestroyed) editor.commands.focus();
  };
  const close = () => { setOpen(false); setOptionsOpen(false); focusEditor(); };
  const requestReveal = () => { revealRequested.current = true; setNavigation(value => value + 1); };
  useEffect(() => {
    if (!editor || !open || !enabled) return;
    const update = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) setRevision(value => value + 1);
    };
    editor.on("transaction", update);
    return () => { editor.off("transaction", update); };
  }, [editor, open, enabled]);
  const hits = useMemo(() => {
    if (!open || !enabled || !query) return [];
    if (sourceRef) return findText(sourceRef.current?.view?.state.doc.toString() ?? body ?? "", query, caseSensitive);
    return editor && !editor.isDestroyed ? findInEditor(editor, query, caseSensitive) : [];
  }, [open, enabled, query, caseSensitive, sourceRef, editor, body, revision]);
  const current = hits.length ? Math.min(active, hits.length - 1) : -1;
  const move = (direction: number) => {
    if (hits.length) {
      setActive((current + direction + hits.length) % hits.length);
      requestReveal();
    }
  };
  const show = (replace: boolean) => {
    if (!open) {
      const view = sourceRef?.current?.view;
      const selected = view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
        : editor && !editor.isDestroyed ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n") : "";
      if (selected && selected.length <= 200 && !selected.includes("\n")) setQuery(selected);
      setActive(0);
    }
    setReplaceOpen(replace && editable);
    setOptionsOpen(false);
    setNotice(""); setOpen(true); requestReveal();
    if (open) focusInput();
  };
  const replaceMatches = (all: boolean) => {
    if (!enabled || !editable || !query) return;
    const view = sourceRef?.current?.view;
    if (sourceRef ? !view || view.state.readOnly : !editor || editor.isDestroyed || !editor.isEditable) return;
    // 편집 직전의 본문에서 위치를 다시 계산한다.
    const fresh = view ? findText(view.state.doc.toString(), query, caseSensitive) : findInEditor(editor!, query, caseSensitive);
    if (!fresh.length) return;
    const index = Math.min(active, fresh.length - 1);
    const selected = all ? fresh : [fresh[index]];
    if (view) sourceRef!.current!.replaceRanges(selected, replacement);
    else {
      const tr = editor!.state.tr;
      for (const hit of [...selected].reverse()) {
        tr.setStoredMarks(null).insertText(replacement, hit.from, hit.to);
      }
      editor!.view.dispatch(closeHistory(tr));
      editor!.view.dispatch(closeHistory(editor!.state.tr));
    }
    const after = view ? findText(view.state.doc.toString(), query, caseSensitive) : findInEditor(editor!, query, caseSensitive);
    const next = all ? 0 : after.findIndex(hit => hit.from >= fresh[index].from + replacement.length);
    setActive(Math.max(0, next));
    setRevision(value => value + 1);
    setNotice(`${selected.length}곳을 치환했습니다.`);
    requestReveal();
  };
  useEffect(() => {
    if (sourceRef) sourceRef.current?.highlight(hits, current);
    else if (editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta(findKey, { hits, active: current }).setMeta("addToHistory", false));
    // 본문을 고칠 때는 강조만 갱신하고, 명시적으로 찾을 때만 커서를 옮긴다.
    if (!revealRequested.current) return;
    revealRequested.current = false;
    const hit = hits[current];
    if (!hit) return;
    if (sourceRef) sourceRef.current?.revealRange(hit);
    else if (editor && !editor.isDestroyed) {
      editor.commands.setTextSelection(hit);
      const scroll = editor.view.dom.closest<HTMLElement>(".editor-scroll");
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        const panelBottom = bar.current?.getBoundingClientRect().bottom ?? bounds.top;
        const top = Math.min(bounds.bottom, Math.max(bounds.top, panelBottom + 8));
        scroll.scrollTop += editor.view.coordsAtPos(hit.from).top - (top + bounds.bottom) / 2;
      }
    }
  }, [hits, current, editor, sourceRef, navigation]);
  useEffect(() => () => {
    if (sourceRef) sourceRef.current?.highlight([], -1);
    else if (editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta(findKey, { hits: [], active: -1 }).setMeta("addToHistory", false));
  }, [editor, sourceRef]);
  useEffect(() => {
    if (open && enabled) focusInput();
  }, [open, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const openRequested = (event: Event) => {
      if (document.documentElement.dataset.pinLocked === "true") return;
      const replace = (event as CustomEvent<{ replace?: boolean }>).detail?.replace === true;
      show(replace);
    };
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.documentElement.dataset.pinLocked === "true") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], .modal-backdrop')) return;
      const find = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === "KeyF";
      const replace = event.key === "F3" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
      if (find || replace) {
        event.preventDefault(); event.stopPropagation();
        if (!open || replace) show(replace);
        else if (find) focusInput();
      } else if (open && event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (open && target === input.current && event.key === "Enter" && !event.isComposing && !composing.current && event.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("lof:editor-find", openRequested);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("lof:editor-find", openRequested);
    };
  });
  if (!open || !enabled) return null;
  const dom = sourceRef?.current?.view?.dom ?? (editor && !editor.isDestroyed ? editor.view.dom : null);
  const floatingHost = dom?.closest<HTMLElement>(".group-body, .m-editor-screen, .m-memo-editor-screen");
  const panel = <div ref={bar} className={`editor-find${floatingHost ? " is-floating" : ""}`} role="search" aria-label={replaceOpen ? "현재 문서 문자 치환" : "현재 문서에서 찾기"}>
    <div className="editor-find-row editor-find-search-row">
      <div className="editor-find-search-field">
        <Search size={20} aria-hidden="true" />
        <input ref={input} aria-label="문서 내 검색어" placeholder="검색..." value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); setNotice(""); requestReveal(); }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
        {query && <span className="editor-find-count" role="status" aria-live="polite">{hits.length ? `${current + 1}/${hits.length}` : "0건"}</span>}
      </div>
      <button type="button" aria-label="이전 검색 결과" title="이전 결과 (Shift+Enter)" disabled={!hits.length} onClick={() => move(-1)}><ArrowUp size={20} /></button>
      <button type="button" aria-label="다음 검색 결과" title="다음 결과 (Enter)" disabled={!hits.length} onClick={() => move(1)}><ArrowDown size={20} /></button>
      <button type="button" aria-label="검색 옵션" title="검색 옵션" aria-expanded={optionsOpen}
        className={optionsOpen || caseSensitive ? "active" : ""} onClick={() => setOptionsOpen(value => !value)}><TextSelect size={20} /></button>
      <button type="button" aria-label="문서 내 검색 닫기" title="닫기 (Esc)" onClick={close}><X size={20} /></button>
    </div>
    {replaceOpen && editable && <div className="editor-find-row editor-find-replace-row">
      <input className="editor-find-replacement" aria-label="바꿀 문자" placeholder="바꾸기" title="비워두면 찾은 문자를 삭제합니다." value={replacement}
        onChange={event => { setReplacement(event.target.value); setNotice(""); }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); replaceMatches(false);
          }
        }} />
      <button type="button" aria-label="치환" title="치환" disabled={!hits.length} onClick={() => replaceMatches(false)}><Replace size={20} /></button>
      <button type="button" aria-label="모두 치환" title="모두 치환" disabled={!hits.length} onClick={() => replaceMatches(true)}><ReplaceAll size={20} /></button>
    </div>}
    {optionsOpen && <div className="editor-find-options">
      <label><input type="checkbox" checked={caseSensitive} onChange={event => {
        setCaseSensitive(event.target.checked); setActive(0); setNotice(""); requestReveal();
      }} />대소문자 구분</label>
      {editable && <label><input type="checkbox" checked={replaceOpen}
        onChange={event => setReplaceOpen(event.target.checked)} />바꾸기 표시</label>}
    </div>}
    {notice && <span className="editor-find-notice" role="status">{notice}</span>}
  </div>;
  return floatingHost ? createPortal(panel, floatingHost) : panel;
}
