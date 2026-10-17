import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
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

export default function EditorFind({ editor, sourceRef, body, enabled }: {
  editor?: Editor | null;
  sourceRef?: RefObject<SourceEditorHandle | null>;
  body?: string;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
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
  const close = () => { setOpen(false); focusEditor(); };
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
    if (sourceRef) return findText(body ?? "", query, caseSensitive);
    const found: FindRange[] = [];
    if (editor && !editor.isDestroyed) editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      // 줄바꿈·이미지를 한 칸으로 두어 편집기 좌표와 일치시킨다.
      found.push(...findText(node.textBetween(0, node.content.size, "", "\ufffc"), query, caseSensitive, pos + 1));
      return false;
    });
    return found;
  }, [open, enabled, query, caseSensitive, sourceRef, editor, body, revision]);
  const current = hits.length ? Math.min(active, hits.length - 1) : -1;
  const move = (direction: number) => {
    if (hits.length) {
      setActive((current + direction + hits.length) % hits.length);
      requestReveal();
    }
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
        scroll.scrollTop += editor.view.coordsAtPos(hit.from).top - bounds.top - bounds.height / 2;
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
    const element = bar.current, manuscript = element?.closest<HTMLElement>(".manuscript");
    if (!element || !manuscript) return;
    const resize = new ResizeObserver(() => {
      manuscript.style.setProperty("--editor-find-offset", `${element.offsetHeight + 8}px`);
    });
    resize.observe(element);
    return () => { resize.disconnect(); manuscript.style.removeProperty("--editor-find-offset"); };
  }, [open, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.documentElement.dataset.pinLocked === "true") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], .modal-backdrop')) return;
      const find = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === "KeyF";
      const next = event.key === "F3" && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (find || next) {
        event.preventDefault(); event.stopPropagation();
        if (!open) {
          const selection = sourceRef?.current?.view;
          const selected = selection ? selection.state.sliceDoc(selection.state.selection.main.from, selection.state.selection.main.to)
            : editor && !editor.isDestroyed ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n") : "";
          if (selected && selected.length <= 200 && !selected.includes("\n")) setQuery(selected);
          setActive(0); setOpen(true); requestReveal();
        } else if (find) focusInput();
        else move(event.shiftKey ? -1 : 1);
      } else if (open && event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (open && target === input.current && event.key === "Enter" && !event.isComposing && !composing.current && event.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });
  if (!open || !enabled) return null;
  return <div ref={bar} className="editor-find" role="search" aria-label="현재 문서에서 찾기">
    <Search size={16} aria-hidden="true" />
    <input ref={input} aria-label="문서 내 검색어" placeholder="현재 문서에서 찾기" value={query}
      onChange={event => { setQuery(event.target.value); setActive(0); requestReveal(); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
    <button type="button" className={caseSensitive ? "active" : ""} aria-label="대소문자 구분" aria-pressed={caseSensitive}
      title="대소문자 구분" onClick={() => { setCaseSensitive(value => !value); setActive(0); requestReveal(); }}>Aa</button>
    <span className="editor-find-count" role="status" aria-live="polite">{query ? hits.length ? `${current + 1} / ${hits.length}` : "결과 없음" : "검색어 입력"}</span>
    <button type="button" aria-label="이전 검색 결과" title="이전 결과 (Shift+F3)" disabled={!hits.length} onClick={() => move(-1)}><ChevronUp size={16} /></button>
    <button type="button" aria-label="다음 검색 결과" title="다음 결과 (F3)" disabled={!hits.length} onClick={() => move(1)}><ChevronDown size={16} /></button>
    <button type="button" aria-label="문서 내 검색 닫기" title="닫기 (Esc)" onClick={close}><X size={16} /></button>
  </div>;
}
