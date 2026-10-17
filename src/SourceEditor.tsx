import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { plainText } from "../core/text.mjs";
import { pairedBackspace, typingPlan } from "../core/typing.mjs";
import { markdownImage } from "./image-extension";
import { textCounts, type ManuscriptCounts } from "./manuscript-counts";
import type { WritingRules } from "./types";
import type { FindRange } from "./EditorFind";

type Image = { src: string; alt: string };
const externalChange = Annotation.define<boolean>();
const editableConfig = new Compartment();
const contentConfig = new Compartment();
const findMarks = StateEffect.define<{ hits: FindRange[]; active: number }>();
const findHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(findMarks)) {
      marks = Decoration.set(effect.value.hits.map((hit, index) => Decoration.mark({
        class: `editor-find-hit${index === effect.value.active ? " current" : ""}`,
      }).range(hit.from, hit.to)), true);
    }
    return marks;
  },
  provide: field => EditorView.decorations.from(field),
});

function inCode(state: EditorState, position = state.selection.main.from): boolean {
  const tree = ensureSyntaxTree(state, position, 2) ?? syntaxTree(state);
  // 아직 해석되지 않은 위치에서는 자동 완성을 보수적으로 생략한다.
  if (tree.length < position) return true;
  for (let node = tree.resolveInner(position, -1); node; node = node.parent!) {
    if (["FencedCode", "CodeBlock", "InlineCode", "CodeText"].includes(node.name)) return true;
  }
  return false;
}

// 일반 문장의 한 줄 수정만 즉시 센다. 문법·블록 경계가 바뀌면 전체 계산 결과를 기다린다.
function countDelta(update: ViewUpdate, rules?: WritingRules): ManuscriptCounts | null {
  if (!rules || update.changes.empty) return null;
  let changed: { fromA: number; toA: number; fromB: number; toB: number } | null = null;
  let ranges = 0;
  update.changes.iterChangedRanges((fromA, toA, fromB, toB) => { changed = { fromA, toA, fromB, toB }; ranges++; });
  if (ranges !== 1 || !changed) return null;
  const { fromA, toA, fromB, toB } = changed as { fromA: number; toA: number; fromB: number; toB: number };
  const oldLine = update.startState.doc.lineAt(fromA), newLine = update.state.doc.lineAt(fromB);
  if (toA > oldLine.to || toB > newLine.to || /^\s*(?:[>#`~|]|[-*+]\s|\d+[.)]\s| {4})/.test(oldLine.text) ||
      /^\s*(?:[>#`~|]|[-*+]\s|\d+[.)]\s| {4})/.test(newLine.text) ||
      /[\n\r\u2028\u2029\[\]<>`&\\*_~#|=\-]/.test(oldLine.text + newLine.text)) return null;
  if (update.startState.doc.lines > 1 && (!oldLine.text.trim() || !newLine.text.trim())) return null;
  if (inCode(update.startState, fromA) || inCode(update.state, fromB)) return null;
  const before = textCounts(plainText(oldLine.text), rules), after = textCounts(plainText(newLine.text), rules);
  for (const key of Object.keys(after) as (keyof ManuscriptCounts)[]) after[key] -= before[key];
  if (update.startState.doc.lines > 1) { after.lines = 0; after.paragraphs = 0; }
  return after;
}

export type SourceEditorHandle = {
  readonly view: EditorView | null;
  replace: (from: number, to: number, text: string, caret?: number) => void;
  paste: (text: string) => void;
  insertImage: (image: Image) => void;
  reveal: (query: string, index: number, caseSensitive?: boolean) => void;
  highlight: (hits: FindRange[], active: number) => void;
  revealRange: (hit: FindRange) => void;
};

type Props = {
  id: string; body: string; editable: boolean; inactive: boolean; visible: boolean;
  fontSize: number; lineHeight: number; manualLineBreak: boolean;
  typingOptions: Record<string, any>; countingRules?: WritingRules;
  reveal?: { query: string; index: number; caseSensitive?: boolean; seq?: number } | null;
  normalizePaste: (text: string, manual: boolean) => string;
  onChange: (body: string, delta?: ManuscriptCounts | null) => void;
  onComposition: (value: boolean) => void;
  onCursorLine?: (line: number) => void;
  onPasteImage: (event: ClipboardEvent, insert: (image: Image) => void) => boolean;
};

const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const lastBody = useRef(props.body);
  const handle = useRef<SourceEditorHandle>({
    get view() { return viewRef.current; },
    highlight(hits, active) {
      viewRef.current?.dispatch({ effects: findMarks.of({ hits, active }) });
    },
    revealRange(hit) {
      viewRef.current?.dispatch({ selection: { anchor: hit.from, head: hit.to },
        effects: EditorView.scrollIntoView(hit.from, { y: "center" }) });
    },
    replace(from, to, text, caret = from + text.length) {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: caret },
        scrollIntoView: true, annotations: Transaction.userEvent.of("input") });
      view.focus();
    },
    paste(text) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const insert = latest.current.manualLineBreak || inCode(view.state) ? text : latest.current.normalizePaste(text, false);
      handle.current.replace(from, to, insert);
    },
    insertImage(image) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main, doc = view.state.doc;
      const before = from > 0 ? doc.sliceString(from - 1, from) : "";
      const after = doc.sliceString(to, Math.min(doc.length, to + 1));
      const insert = (before && before !== "\n" ? "\n" : "") + markdownImage(image) + (after === "\n" ? "" : "\n");
      handle.current.replace(from, to, insert);
    },
    reveal(query, index, caseSensitive) {
      const view = viewRef.current;
      if (!view || !query) return;
      const text = caseSensitive ? view.state.doc.toString() : view.state.doc.toString().toLocaleLowerCase();
      const target = caseSensitive ? query : query.toLocaleLowerCase();
      let found = -1;
      for (let i = 0, from = 0; i <= index; i++) {
        const next = text.indexOf(target, from);
        if (next < 0) break;
        found = next; from = next + target.length;
      }
      if (found < 0) return;
      view.dispatch({ selection: { anchor: found, head: found + target.length },
        effects: EditorView.scrollIntoView(found, { y: "center" }) });
      view.focus();
    },
  });
  useImperativeHandle(ref, () => handle.current, []);
  const attributes = () => EditorView.contentAttributes.of({
    "aria-label": latest.current.inactive ? "다른 그룹 Markdown 원문" : "Markdown 원문",
    "aria-multiline": "true", role: "textbox", spellcheck: "false",
  });
  const editable = () => [EditorState.readOnly.of(!latest.current.editable), EditorView.editable.of(latest.current.editable)];
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: latest.current.body, extensions: [
        markdown({ extensions: GFM, addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false }),
        history(), keymap.of([...historyKeymap, ...defaultKeymap]), EditorView.lineWrapping,
        findHighlights,
        editableConfig.of(editable()), contentConfig.of(attributes()),
        EditorView.clipboardInputFilter.of((text, state) => latest.current.manualLineBreak || inCode(state)
          ? text : latest.current.normalizePaste(text, false)),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(tr => tr.annotation(externalChange))) {
            const body = update.state.doc.toString(); lastBody.current = body;
            latest.current.onChange(body, countDelta(update, latest.current.countingRules));
          }
          if ((update.docChanged || update.selectionSet) && latest.current.visible && !latest.current.inactive)
            latest.current.onCursorLine?.(update.state.doc.lineAt(update.state.selection.main.head).number);
        }),
        EditorView.domEventHandlers({
          paste(event) { return latest.current.editable && latest.current.onPasteImage(event, image => handle.current.insertImage(image)); },
          keydown(event, view) {
            if (!latest.current.editable || view.composing || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
                (event.key.length !== 1 && event.key !== "Backspace")) return false;
            const { from, to } = view.state.selection.main, doc = view.state.doc;
            const beforeLine = doc.lineAt(from), afterLine = doc.lineAt(to);
            const before = doc.sliceString(beforeLine.from, from), after = doc.sliceString(to, afterLine.to);
            const options = { ...latest.current.typingOptions, inCode: inCode(view.state) };
            if (event.key === "Backspace" && from === to && pairedBackspace(before, after, options)) {
              handle.current.replace(from - 1, to + 1, "", from - 1); return true;
            }
            const plan = typingPlan(before, doc.sliceString(from, to), after, event.key, options);
            if (!plan) return false;
            if (plan.skip) view.dispatch({ selection: { anchor: from + plan.skip } });
            else {
              const start = from - plan.deleteBefore;
              handle.current.replace(start, to + (plan.deleteAfter || 0), plan.insert, start + plan.caret);
            }
            return true;
          },
        }),
        EditorView.domEventObservers({
          compositionstart() { if (latest.current.editable) latest.current.onComposition(true); },
          compositionend() { if (latest.current.editable) latest.current.onComposition(false); },
        }),
      ] }),
    });
    viewRef.current = view; lastBody.current = latest.current.body;
    return () => {
      if (view.composing) latest.current.onComposition(false);
      viewRef.current = null; view.destroy();
    };
  }, [props.id]);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || props.body === lastBody.current) return;
    // 외부 수정만 반영한다. 로컬 입력 때는 트리·실행 취소·한글 조합 상태를 유지한다.
    if (view.composing) return;
    const old = view.state.doc.toString(), next = props.body;
    let start = 0, endA = old.length, endB = next.length;
    while (start < endA && start < endB && old[start] === next[start]) start++;
    while (endA > start && endB > start && old[endA - 1] === next[endB - 1]) { endA--; endB--; }
    lastBody.current = next;
    if (start !== endA || start !== endB) view.dispatch({
      changes: { from: start, to: endA, insert: next.slice(start, endB) },
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    });
  }, [props.body]);
  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: [editableConfig.reconfigure(editable()), contentConfig.reconfigure(attributes())] });
  }, [props.editable, props.inactive]);
  useLayoutEffect(() => {
    if (props.visible) {
      viewRef.current?.requestMeasure();
      const view = viewRef.current;
      if (view && !props.inactive) props.onCursorLine?.(view.state.doc.lineAt(view.state.selection.main.head).number);
    }
  }, [props.visible, props.inactive]);
  useLayoutEffect(() => { viewRef.current?.requestMeasure(); }, [props.fontSize, props.lineHeight]);
  useLayoutEffect(() => {
    if (props.reveal?.query) handle.current.reveal(props.reveal.query, props.reveal.index, props.reveal.caseSensitive);
  }, [props.reveal?.seq, props.id]);
  return <div ref={host} className="source-codemirror" style={{ fontSize: props.fontSize, lineHeight: props.lineHeight }} />;
});
export default SourceEditor;
