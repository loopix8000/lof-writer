import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { plainText } from "../core/text.mjs";
import { commentBackspace, commentPairEnter, pairedBackspace, typingPlan } from "../core/typing.mjs";
import { COMMENT_CLOSE, COMMENT_OPEN, scanComments } from "./doc-index";
import { markdownImage } from "./image-extension";
import { textCounts, type ManuscriptCounts } from "./manuscript-counts";
import type { WritingRules } from "./types";
import type { FindRange } from "./EditorFind";
import { readEditorSelection, saveEditorSelection, type EditorSession } from "./workspace-state";
import type { UndoState } from "./useUndoState";

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

function buildJsdocDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  if (!text.includes(COMMENT_OPEN)) return Decoration.none;
  const marks = [];
  const lines = new Set<number>();
  for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (to > from) marks.push(Decoration.mark({ class: "jsdoc-comment" }).range(from, to));
    for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
      const line = state.doc.line(number);
      const outside = text.slice(line.from, Math.max(line.from, from)) + text.slice(Math.min(line.to, to), line.to);
      if (!outside.trim()) lines.add(line.from);
    }
  }
  for (const from of lines) marks.push(Decoration.line({ class: "comment-line" }).range(from));
  return marks.length ? Decoration.set(marks, true) : Decoration.none;
}

const hasCommentToken = (text: string) => text.includes(COMMENT_OPEN) || text.includes(COMMENT_CLOSE);
// 기호는 한 줄에 붙어 있어야 하므로 바뀐 줄만 보면 된다.
function touchesCommentToken(tr: Transaction) {
  let found = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (found) return;
    const before = tr.startState.doc, after = tr.newDoc;
    found = hasCommentToken(before.sliceString(before.lineAt(fromA).from, before.lineAt(toA).to)) ||
      hasCommentToken(after.sliceString(after.lineAt(fromB).from, after.lineAt(toB).to));
  });
  return found;
}

// 주석 장식과, 원문 어딘가에 주석 열기가 있는지. 주석 밖의 입력은 위치만 옮긴다.
const jsdocHighlights = StateField.define<{ marks: DecorationSet; open: boolean }>({
  create: (state) => ({ marks: buildJsdocDecorations(state), open: state.doc.toString().includes(COMMENT_OPEN) }),
  update(value, tr) {
    if (!tr.docChanged) return value;
    let inside = false;
    tr.changes.iterChangedRanges((from, to) => {
      value.marks.between(tr.startState.doc.lineAt(from).from, tr.startState.doc.lineAt(to).to,
        () => { inside = true; });
    });
    if (!inside && !touchesCommentToken(tr)) return { marks: value.marks.map(tr.changes), open: value.open };
    return { marks: buildJsdocDecorations(tr.state), open: tr.newDoc.toString().includes(COMMENT_OPEN) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
});

function toggleSourceJsdocComment(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const text = view.state.doc.toString();
  if (from === to) {
    if (text.includes(COMMENT_OPEN)) {
      for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
        const mStart = match.index ?? 0;
        const mEnd = mStart + match[0].length;
        if (mStart <= from && from <= mEnd) {
          const raw = match[0];
          const openLen = raw.match(/^<!--\s?/)?.[0].length ?? COMMENT_OPEN.length;
          const closeLen = raw.match(/\s?-->$/)?.[0].length ?? COMMENT_CLOSE.length;
          const inner = raw.slice(openLen, Math.max(openLen, raw.length - closeLen));
          const nextCursor = mStart + Math.max(0, Math.min(inner.length, from - mStart - openLen));
          view.dispatch({
            changes: { from: mStart, to: mEnd, insert: inner },
            selection: { anchor: nextCursor },
            scrollIntoView: true,
            annotations: Transaction.userEvent.of("input"),
          });
          return true;
        }
      }
    }
    view.dispatch({
      changes: { from, to, insert: `${COMMENT_OPEN}  ${COMMENT_CLOSE}` },
      selection: { anchor: from + COMMENT_OPEN.length + 1 },
      scrollIntoView: true,
      annotations: Transaction.userEvent.of("input"),
    });
    return true;
  }
  const selected = view.state.sliceDoc(from, to);
  if (/^\s*<!--[\s\S]*-->\s*$/.test(selected)) {
    const unwrapped = selected.replace(/^(\s*)<!--\s?/, "$1").replace(/\s?-->(\s*)$/, "$1");
    view.dispatch({
      changes: { from, to, insert: unwrapped },
      selection: { anchor: from, head: from + unwrapped.length },
      scrollIntoView: true,
      annotations: Transaction.userEvent.of("input"),
    });
    return true;
  }
  const wrapped = `${COMMENT_OPEN} ${selected} ${COMMENT_CLOSE}`;
  view.dispatch({
    changes: { from, to, insert: wrapped },
    selection: { anchor: from + COMMENT_OPEN.length + 1, head: to + COMMENT_OPEN.length + 1 },
    scrollIntoView: true,
    annotations: Transaction.userEvent.of("input"),
  });
  return true;
}

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
  if (update.startState.field(jsdocHighlights).open || update.state.field(jsdocHighlights).open) return null;
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
  undo: () => void;
  redo: () => void;
  replace: (from: number, to: number, text: string, caret?: number) => void;
  paste: (text: string) => void;
  insertImage: (image: Image) => void;
  reveal: (query: string, index: number, caseSensitive?: boolean) => void;
  highlight: (hits: FindRange[], active: number) => void;
  revealRange: (hit: FindRange) => void;
};

type Props = {
  session?: EditorSession;
  id: string; body: string; editable: boolean; inactive: boolean; visible: boolean;
  fontSize: number; lineHeight: number; manualLineBreak: boolean;
  typingOptions: Record<string, any>; countingRules?: WritingRules;
  reveal?: { query: string; index: number; caseSensitive?: boolean; seq?: number } | null;
  normalizePaste: (text: string, manual: boolean) => string;
  onChange: (body: string, delta?: ManuscriptCounts | null) => void;
  onCursorLine?: (line: number) => void;
  onUndoStateChange?: (state: UndoState) => void;
  onPasteImage: (event: ClipboardEvent, insert: (image: Image) => void) => boolean;
};

const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const lastBody = useRef(props.body);
  const handle = useRef<SourceEditorHandle>({
    get view() { return viewRef.current; },
    undo() {
      const view = viewRef.current;
      if (view && !view.state.readOnly && undo(view)) view.focus();
    },
    redo() {
      const view = viewRef.current;
      if (view && !view.state.readOnly && redo(view)) view.focus();
    },
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
  const reportUndoState = (state: EditorState) => {
    const enabled = latest.current.editable && latest.current.visible && !latest.current.inactive;
    latest.current.onUndoStateChange?.({ canUndo: enabled && undoDepth(state) > 0, canRedo: enabled && redoDepth(state) > 0 });
  };
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.body,
        selection: readEditorSelection(latest.current.session, "source", latest.current.body.length),
        extensions: [
        markdown({ extensions: GFM, addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false }),
        history(), keymap.of([{ key: "Mod-/", run: toggleSourceJsdocComment }, ...historyKeymap, ...defaultKeymap]), EditorView.lineWrapping,
        findHighlights,
        jsdocHighlights,
        editableConfig.of(editable()), contentConfig.of(attributes()),
        EditorView.clipboardInputFilter.of((text, state) => latest.current.manualLineBreak || inCode(state)
          ? text : latest.current.normalizePaste(text, false)),
        EditorView.updateListener.of(update => {
          reportUndoState(update.state);
          if (update.docChanged || update.selectionSet) {
            const { anchor, head } = update.state.selection.main;
            saveEditorSelection(latest.current.session, "source", { anchor, head });
          }
          if (update.docChanged && !update.transactions.some(tr => tr.annotation(externalChange))) {
            const body = update.state.doc.toString(); lastBody.current = body;
            latest.current.onChange(body, countDelta(update, latest.current.countingRules));
          }
          if ((update.docChanged || update.selectionSet) && latest.current.visible && !latest.current.inactive)
            latest.current.onCursorLine?.(update.state.doc.lineAt(update.state.selection.main.head).number);
        }),
        Prec.high(EditorView.domEventHandlers({
          paste(event) { return latest.current.editable && latest.current.onPasteImage(event, image => handle.current.insertImage(image)); },
          keydown(event, view) {
            if (!latest.current.editable || view.composing || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
                (event.key.length !== 1 && event.key !== "Backspace" && event.key !== "Enter")) return false;
            const { from, to } = view.state.selection.main, doc = view.state.doc;
            const beforeLine = doc.lineAt(from), afterLine = doc.lineAt(to);
            const before = doc.sliceString(beforeLine.from, from), after = doc.sliceString(to, afterLine.to);
            const comment = { open: false, stray: false };
            if (view.state.field(jsdocHighlights).open) scanComments(doc.sliceString(0, from), comment);
            const options = { ...latest.current.typingOptions, inCode: inCode(view.state), inComment: comment.open };
            if (event.key === "Enter" && !event.shiftKey && from === to && commentPairEnter(before, after, options)) {
              const start = from - (before.match(/[ \t]*$/)?.[0].length ?? 0);
              const end = to + (after.match(/^[ \t]*/)?.[0].length ?? 0);
              handle.current.replace(start, end, "\n\n", start + 1); return true;
            }
            if (event.key === "Backspace" && from === to) {
              const commentPair = commentBackspace(before, after, options);
              const padding = commentPair && before.endsWith(`${COMMENT_OPEN} `) ? 1 : 0;
              const closer = commentPair ? COMMENT_CLOSE.length + padding : pairedBackspace(before, after, options) ? 1 : 0;
              if (closer) { handle.current.replace(from - 1 - padding, to + closer, "", from - 1 - padding); return true; }
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
        })),
      ] }),
    });
    viewRef.current = view; lastBody.current = latest.current.body;
    reportUndoState(view.state);
    return () => {
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
    const current = viewRef.current;
    if (current) reportUndoState(current.state);
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
