import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Undo2,
  Redo2,
  Heading2,
  Minus,
  ArrowRightLeft,
  Table2,
  Trash2,
  Scissors,
  Copy,
  NotebookPen,
  SquareDashed,
  ClipboardPaste,
  ImagePlus,
  MessageSquareCode,
  Code2,
  Bookmark as BookmarkIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { BubbleMenu } from "@tiptap/react/menus";
import { getTextBetween, getTextSerializersFromSchema, type Editor } from "@tiptap/core";
import { requiresSource, splitSoftBreaks } from "../core/text.mjs";
import type { SourceEditorHandle } from "./SourceEditor";
import { blockAt, docIndex, docNeedsMarkdownCopy, nodeLineCount } from "./doc-index";
import { normalizeEditorStyle } from "../core/typesetting.mjs";
import { TypingAssist, isInsideJsdocComment, toggleJsdocComment, typesettingPluginKey } from "./typing-extension";
import { MarkdownTables } from "./table-extension";
import TableControls from "./TableControls";
import { MarkdownTasks } from "./task-extension";
import { Bookmarks, BOOKMARK_LOAD, bookmarkPluginKey, isBookmarkedAt, markable, readBookmarks, resolveBookmarks, toggleBookmarkAt } from "./bookmark-extension";
import { call, type Bookmark, type WritingRules } from "./types";
import { paragraphCountDelta, type ManuscriptCounts } from "./manuscript-counts";
import { MarkdownImage } from "./image-extension";
import { NoteMarks, notePluginKey } from "./note-extension";
import { NOTE_LINK_PROTOCOL, noteLinkTarget, type NoteMark } from "./note-links";
import { isRelativeDocumentLink } from "./document-links";
import LineBreakControl from "./LineBreakControl";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorProps, EditorView } from "@tiptap/pm/view";
import { createCachedMarkdown } from "./cached-markdown";
import EditorFind, { FindHighlights } from "./EditorFind";
import { searchLine, searchPattern } from "./search-pattern";
import { readEditorSelection, saveEditorSelection, type EditorSession } from "./workspace-state";
import type { UndoState } from "./useUndoState";

const SourceEditor = lazy(() => import("./SourceEditor"));

function clipboardTextParser(manual: boolean): NonNullable<EditorProps["clipboardTextParser"]> {
  return (text, $context, _plainText, view) => {
    const { schema } = view.state;
    const marks = $context.marks();
    const lines = text.split(/\r\n?|\n/);
    const kept = manual ? lines : lines.filter((line, index) =>
      line.trim() !== "" || index === 0 || index === lines.length - 1);
    const paragraphs = kept.map((line) =>
      schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : undefined),
    );
    return new Slice(Fragment.fromArray(paragraphs), 1, 1);
  };
}

const parseManualClipboardText = clipboardTextParser(true);
const parseAutomaticClipboardText = clipboardTextParser(false);

// 키보드 클립보드의 여러 줄 입력도 일반 붙여넣기와 같은 문단으로 넣는다.
function insertAutomaticText(view: EditorView, text: string, from = view.state.selection.from, to = view.state.selection.to) {
  if (!view.editable || !/[\r\n]/.test(text)) return false;
  const $from = view.state.doc.resolve(from);
  if ($from.parent.type.spec.code) return false;
  const slice = parseAutomaticClipboardText(text, $from, true, view);
  if (!slice) return false;
  const tr = view.state.tr.replaceRange(from, to, slice);
  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(to, 1))));
  view.dispatch(tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
  return true;
}

// HTML로 붙여 넣은 줄도 자동 관리의 문단 간격 하나로 표시한다.
const normalizeAutomaticHtmlPaste: NonNullable<EditorProps["transformPasted"]> = (slice, _view, plain) => {
  if (plain) return slice;
  const normalize = (content: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    content.forEach((node) => {
      if (node.type.name === "paragraph" && node.content.content.some((child) =>
        child.type.name === "hardBreak" || (child.isText && /[\r\n]/.test(child.text!)))) {
        const lines: PMNode[][] = [[]];
        node.content.forEach((child) => {
          if (child.type.name === "hardBreak") lines.push([]);
          else if (child.isText && /[\r\n]/.test(child.text!)) {
            child.text!.split(/\r\n?|\n/).forEach((text, index) => {
              if (index) lines.push([]);
              if (text) lines[lines.length - 1].push(child.type.schema.text(text, child.marks));
            });
          }
          else lines[lines.length - 1].push(child);
        });
        if (lines.every((line) => line.every((child) => child.isText && !child.text!.trim()))) {
          nodes.push(node.copy(Fragment.empty));
        } else {
          nodes.push(...lines.map((line) => node.copy(Fragment.fromArray(line))));
        }
      } else {
        nodes.push(!node.isLeaf && !node.type.spec.code ? node.copy(normalize(node.content)) : node);
      }
    });
    const kept = nodes.filter((node, index) => index === 0 || index === nodes.length - 1 ||
      node.type.name !== "paragraph" || !node.content.content.every((child) => child.isText && !child.text!.trim()));
    return Fragment.fromArray(kept);
  };
  return new Slice(normalize(slice.content), slice.openStart, slice.openEnd);
};

// 복사 단축키와 우클릭 메뉴가 같은 문단 간격을 쓰도록 한다. 표 선택은 선택한 셀만 복사한다.
function automaticClipboardTextSerializer(blankLines: boolean): NonNullable<EditorProps["clipboardTextSerializer"]> {
  return (_slice, view) => {
    const { doc, selection, schema } = view.state;
    const blockSeparator = blankLines ? "\n\n" : "\n";
    const textSerializers = getTextSerializersFromSchema(schema);
    return [...selection.ranges]
      .sort((a, b) => a.$from.pos - b.$from.pos)
      .map(({ $from, $to }) => getTextBetween(doc, { from: $from.pos, to: $to.pos }, {
        blockSeparator,
        textSerializers,
      }))
      .join(blockSeparator);
  };
}

// 문단(textblock) 안의 글자 위치를 편집기 위치로 바꾼다. 글자가 아닌 요소는 건너뛴다.
function offsetToPos(node: PMNode, pos: number, offset: number) {
  let p = pos + 1,
    acc = 0;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i),
      len = child.isText ? child.text!.length : child.textContent.length;
    if (child.isText && offset <= acc + len) return p + (offset - acc);
    acc += len;
    p += child.nodeSize;
  }
  return p;
}
// 커서가 있는 줄 번호(1부터). 문단(표 칸·목록 항목 포함)과 구분선을 한 줄로 센다.
// 앞쪽 블록의 줄 수는 색인에 모아 둔 누적값을 쓰고, 커서가 있는 블록 안만 센다.
function cursorLineAt(doc: PMNode, pos: number) {
  if (pos <= 0) return 1;
  const index = docIndex(doc), i = blockAt(index, pos - 1);
  if (i >= doc.childCount) return Math.max(1, index.lines[i]);
  let line = index.lines[i];
  const visit = (node: PMNode, start: number) => {
    if (start + node.nodeSize <= pos) {
      line += nodeLineCount(node);
      return false;
    }
    if (!node.isTextblock && !(node.isBlock && node.isLeaf)) return true;
    line++;
    if (node.isTextblock)
      node.forEach((child, offset) => {
        if (child.type.name === "hardBreak" && start + 1 + offset < pos) line++;
      });
    return false;
  };
  const block = doc.child(i), start = index.starts[i];
  if (visit(block, start)) block.nodesBetween(0, Math.min(block.content.size, pos - start - 1), visit, start + 1);
  return Math.max(1, line);
}
// 줄바꿈 방식을 바꿀 때 본문의 실제 빈 줄을 맞춘다. 맨 위 단계에서 글이 있는 블록 사이의 빈 문단 묶음만 바꾼다.
// 자동 관리로: 붙여 넣기와 같은 규칙으로 빈 줄 n개를 n/2개(내림)로 줄인다. 빈 줄 1개는 단락 간격이 된다.
// 수동 관리로: 단락 간격 대신 실제 빈 줄을 넣어 빈 줄 k개를 2k+1개로 늘린다(자동 관리로 되돌리면 다시 k개).
function convertBlankLines(editor: Editor, toManual: boolean) {
  const { state } = editor;
  const tr = state.tr,
    paragraph = state.schema.nodes.paragraph;
  // 자동 관리로 바꿀 때는 붙여 넣기 규칙처럼 강제 줄바꿈으로 이어진 줄도 한 줄을 한 문단으로 나눈다.
  if (!toManual) {
    const split: { pos: number; node: PMNode }[] = [];
    state.doc.forEach((node, pos) => {
      if (node.type.name === "paragraph" && node.content.content.some((c) => c.type.name === "hardBreak"))
        split.push({ pos, node });
    });
    for (const { pos, node } of split.reverse()) {
      const lines: PMNode[][] = [[]];
      node.content.forEach((c) => (c.type.name === "hardBreak" ? lines.push([]) : lines[lines.length - 1].push(c)));
      tr.replaceWith(pos, pos + node.nodeSize, lines.map((line) => paragraph.create(node.attrs, line)));
    }
  }
  const isBlank = (node: PMNode) =>
    node.type.name === "paragraph" && node.content.content.every((c) => c.isText && !c.text!.trim());
  const blocks: { pos: number; end: number; blank: boolean }[] = [];
  tr.doc.forEach((node, pos) => blocks.push({ pos, end: pos + node.nodeSize, blank: isBlank(node) }));
  const runs: { from: number; to: number; count: number }[] = [];
  for (let i = 0; i < blocks.length; ) {
    if (blocks[i].blank) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < blocks.length && blocks[j].blank) j++;
    if (j < blocks.length) runs.push({ from: blocks[i].end, to: blocks[j].pos, count: j - i - 1 });
    i = j;
  }
  for (const run of runs.reverse()) {
    const target = toManual ? run.count * 2 + 1 : Math.floor(run.count / 2);
    if (target !== run.count)
      tr.replaceWith(run.from, run.to, Array.from({ length: target }, () => paragraph.create()));
  }
  if (tr.docChanged) editor.view.dispatch(tr);
}
type EditorMenuOps = {
  cut: () => void;
  selectAll: () => void;
  refocus: () => void;
  pasteText: (text: string) => void;
  insertImage: (img: { src: string; alt: string }) => void;
  bookmark?: {
    active: boolean;
    toggle: () => void;
  };
  fallbackQuickNoteText?: string;
};
// 이미지를 눌렀을 때 고르는 크기. 너비(px)로 저장하고 본문 폭보다 넓으면 본문 폭에 맞춘다.
const IMAGE_SIZES: [string, number | null][] = [["작게", 240], ["보통", 400], ["크게", 640], ["원본", null]];

function ImageToolButton({ onPress, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onMouseDown"> & { onPress: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const press = useRef(onPress);
  press.current = onPress;
  const suppressClickUntil = useRef(0);
  useLayoutEffect(() => {
    const button = ref.current;
    if (!button) return;
    let start: { id: number; x: number; y: number } | null = null;
    const touchStart = (event: TouchEvent) => {
      start = null;
      suppressClickUntil.current = Date.now() + 800;
      if (event.touches.length !== 1) return;
      // 기본 포커스 이동과 합성 마우스 클릭을 막아 이미지 선택을 유지한다.
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const touch = event.touches[0];
      start = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    };
    const touchMove = (event: TouchEvent) => {
      const touch = [...event.touches].find(touch => touch.identifier === start?.id);
      if (!touch || !start || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 12) start = null;
    };
    const touchEnd = (event: TouchEvent) => {
      const previous = start;
      start = null;
      suppressClickUntil.current = Date.now() + 800;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const touch = [...event.changedTouches].find(touch => touch.identifier === previous?.id);
      if (!previous || !touch || button.disabled || Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) > 12) return;
      const rect = button.getBoundingClientRect();
      if (touch.clientX >= rect.left && touch.clientX <= rect.right && touch.clientY >= rect.top && touch.clientY <= rect.bottom)
        press.current();
    };
    const touchCancel = () => { start = null; };
    // React의 touch 리스너는 passive이므로 네이티브 리스너에서 기본 동작을 취소한다.
    button.addEventListener("touchstart", touchStart, { passive: false });
    button.addEventListener("touchmove", touchMove, { passive: true });
    button.addEventListener("touchend", touchEnd, { passive: false });
    button.addEventListener("touchcancel", touchCancel);
    return () => {
      button.removeEventListener("touchstart", touchStart);
      button.removeEventListener("touchmove", touchMove);
      button.removeEventListener("touchend", touchEnd);
      button.removeEventListener("touchcancel", touchCancel);
    };
  }, []);
  return <button {...props} type="button" ref={ref}
    onMouseDown={event => event.preventDefault()}
    onClick={event => {
      if (event.detail !== 0 && Date.now() < suppressClickUntil.current) return;
      onPress();
    }} />;
}

// 이미지 위에서 시작한 터치의 위치와 시각. 짧게 누르고 뗐는지 가린다.
let imageTouch: { x: number; y: number; at: number } | null = null;
type SaveImage =(file?: { name: string; data: string }) => Promise<{ src: string; alt: string } | null>;

const imageFiles = (data: DataTransfer | null) =>
  [...(data?.files || [])].filter((file) => file.type.startsWith("image/"));
const fileData = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
// 붙여 넣거나 끌어 놓은 그림 파일을 차례로 assets/에 저장하고 넣는다.
async function saveImageFiles(files: File[], save: SaveImage, insert: (img: { src: string; alt: string }) => void) {
  for (const file of files) {
    const img = await save({ name: file.name || "image.png", data: await fileData(file) });
    if (img) insert(img);
  }
}
// 이미지를 넣는다. 빈 문단이면 그 자리에, 글이 있는 문단이면 그 문단 다음에 새 문단으로 넣어 그림이 한 줄을 따로 차지하게 한다.
function placeImage(view: EditorView, img: { src: string; alt: string }, at?: number) {
  if (view.isDestroyed) return;
  const { state } = view,
    image = state.schema.nodes.image;
  if (!image) return;
  const node = image.create(img);
  const $pos = state.doc.resolve(Math.min(at ?? state.selection.from, state.doc.content.size));
  const tr = state.tr;
  let end: number;
  if (
    $pos.parent.isTextblock &&
    $pos.parent.content.size === 0 &&
    $pos.parent.canReplaceWith($pos.index(), $pos.index(), image)
  ) {
    tr.insert($pos.pos, node);
    end = $pos.pos + node.nodeSize;
  } else {
    const pos = $pos.depth ? $pos.after(1) : $pos.pos;
    tr.insert(pos, state.schema.nodes.paragraph.create(null, node));
    end = pos + node.nodeSize + 1;
  }
  // 마지막 줄에 넣었으면 그 아래에 빈 줄을 하나 두어 바로 이어 쓸 수 있게 한다.
  const $end = tr.doc.resolve(end);
  if ($end.depth === 1 && $end.after(1) === tr.doc.content.size) {
    tr.insert(tr.doc.content.size, state.schema.nodes.paragraph.create());
    end = $end.after(1) + 1;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(end)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
// 링크가 있는 문단 뒤의 첫 인용문 첫 문단 글. 퀵 노트에서는 출처 링크 아래의 '선택한 본문'이다.
function quoteAfter(doc: PMNode, pos: number): string {
  const $pos = doc.resolve(Math.min(pos, doc.content.size)),
    top = $pos.depth ? $pos.before(1) : pos;
  let quote = "";
  doc.forEach((node, offset) => {
    if (!quote && offset > top && node.type.name === "blockquote") quote = node.firstChild?.textContent.trim() || "";
  });
  return quote;
}
// 저장된 북마크를 편집기에 다시 깐다. 되돌리기 기록과 저장 대상에서는 뺀다.
function loadBookmarks(editor: Editor, list: Bookmark[] = []) {
  editor.view.dispatch(
    editor.state.tr
      .setMeta(bookmarkPluginKey, { set: resolveBookmarks(editor.state.doc, list) })
      .setMeta(BOOKMARK_LOAD, true)
      .setMeta("addToHistory", false),
  );
}
function resolveTargetBlockPos(view: EditorView, coords?: { x: number; y: number } | null): number {
  if (view.isDestroyed) return -1;
  const { state } = view;
  const fromDocPos = (pos: number) => {
    const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
    const $pos = state.doc.resolve(clamped);
    const blockPos = $pos.depth ? $pos.before(1) : $pos.pos;
    const node = state.doc.nodeAt(blockPos);
    return node && markable(node) ? blockPos : -1;
  };
  if (coords && (!view.editable || state.selection.empty)) {
    const hit = view.posAtCoords({ left: coords.x, top: coords.y });
    if (hit) {
      const blockPos = fromDocPos(hit.pos);
      if (blockPos >= 0) return blockPos;
    }
  }
  const domSel = view.dom.ownerDocument.getSelection();
  if (domSel?.anchorNode && view.dom.contains(domSel.anchorNode)) {
    try {
      const pos = view.posAtDOM(domSel.anchorNode, domSel.anchorOffset);
      const blockPos = fromDocPos(pos);
      if (blockPos >= 0) return blockPos;
    } catch {}
  }
  const { $from } = state.selection;
  const blockPos = $from.depth ? $from.before(1) : $from.pos;
  const node = state.doc.nodeAt(blockPos);
  return node && markable(node) ? blockPos : -1;
}
function toggleBookmarkWithFlash(view: EditorView, blockPos: number): boolean {
  if (blockPos < 0 || view.isDestroyed) return false;
  const wasBookmarked = isBookmarkedAt(view.state, blockPos);
  if (!toggleBookmarkAt(view, blockPos)) return false;
  if (!wasBookmarked) {
    const dom = view.nodeDOM(blockPos);
    if (dom instanceof HTMLElement) {
      dom.classList.remove("bookmark-flash");
      void dom.offsetWidth;
      dom.classList.add("bookmark-flash");
      setTimeout(() => dom.classList.remove("bookmark-flash"), 1200);
    }
  }
  return true;
}
function FormatBar({ inactive, visible, children }: { inactive: boolean; visible: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useLayoutEffect(() => {
    const bar = ref.current, scroll = bar?.closest<HTMLElement>(".editor-scroll");
    if (!bar || !scroll || !visible) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      if (!scroll.clientHeight) return;
      const top = Number.parseFloat(getComputedStyle(bar).top) || 0;
      const edge = scroll.getBoundingClientRect().top + scroll.clientTop + top;
      setStuck(scroll.scrollTop > 0 && bar.getBoundingClientRect().top <= edge + 0.5);
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
    // 실제 고정 위치를 기준으로 판단하며 스크롤이나 막대 높이는 변경하지 않는다.
    update();
    scroll.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(scroll);
    resize.observe(bar);
    if (bar.parentElement) resize.observe(bar.parentElement);
    return () => {
      scroll.removeEventListener("scroll", schedule);
      resize.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [inactive, visible]);
  const hidden = inactive && stuck;
  return <div ref={ref} className={`format-bar${inactive ? " inactive" : ""}${stuck ? " is-stuck" : ""}`}
    aria-hidden={hidden || undefined} aria-disabled={inactive || undefined} inert={inactive}>
    {children}
  </div>;
}

export default function Writer({
  id,
  body,
  onChange,
  countingRules,
  fontSize,
  lineHeight,
  source,
  onToggleSource,
  typingOptions,
  revision,
  readOnly = false,
  allowReadOnlyAnnotations = false,
  inactive = false,
  visible = true,
  reveal = null,
  manualLineBreak = false,
  copyWithBlankLines = false,
  editorStyle,
  onReplaceSymbols,
  tables = false,
  lineBreak,
  bookmarks,
  onBookmarksChange,
  jumpToBookmark = null,
  onQuickNote,
  links = false,
  onOpenLink,
  notes,
  onOpenNotes,
  contextMenu = false,
  images,
  onCursorLine,
  onUndoStateChange,
  session,
}: {
  id: string;
  body: string;
  onChange: (body: string, delta?: ManuscriptCounts | null, markdownCopy?: boolean) => void;
  countingRules?: WritingRules;
  fontSize: number;
  lineHeight: number;
  source: boolean;
  onToggleSource?: () => void;
  typingOptions: Record<string, any>;
  revision: string;
  session?: EditorSession;
  // 원고 보호 여부와 그룹 포커스를 분리해 도구 막대 구성을 그대로 유지한다.
  readOnly?: boolean;
  // 본문을 잠근 상태에서도 북마크와 퀵노트를 사용할 수 있게 한다.
  allowReadOnlyAnnotations?: boolean;
  inactive?: boolean;
  visible?: boolean;
  // 검색 결과로 열었을 때 본문에서 index번째 일치를 골라 보여 준다. seq가 바뀔 때마다 다시 한다.
  reveal?: { query: string; index: number; caseSensitive?: boolean; seq: number } | null;
  // 수동 줄바꿈 관리: 단락 간격 없이 Enter 한 번이 한 줄이 된다.
  manualLineBreak?: boolean;
  copyWithBlankLines?: boolean;
  editorStyle?: Record<string, any>;
  onReplaceSymbols?: () => void;
  tables?: boolean;
  // 도구 막대의 줄바꿈 방식 버튼. 현재 방식은 manualLineBreak를 쓰고, def는 새 문서 기본값이다.
  lineBreak?: { def: boolean; defaultLabel: string; onChange: (manual: boolean) => void };
  // 원고 북마크. onBookmarksChange가 있을 때만 왼쪽 여백을 눌러 넣고 뺄 수 있다.
  bookmarks?: Bookmark[];
  onBookmarksChange?: (bookmarks: Bookmark[]) => void;
  // 북마크 목록에서 고른 문단(맨 위 단계 순서)으로 옮겨 간다. seq가 바뀔 때마다 다시 한다.
  jumpToBookmark?: { index: number; seq: number } | null;
  // 본문을 고르고 우클릭한 메뉴의 '메모 추가'. 있을 때만 고른 글에 우클릭 메뉴를 띄운다.
  // at은 우클릭한 화면 위치로, 퀵 노트 창을 그 근처에 연다.
  onQuickNote?: (text: string, at: { x: number; y: number }) => void;
  // Markdown 링크를 원문 편집 없이 보여 준다(플롯·메모). 문서 링크나 상대 경로를 누르면 onOpenLink에
  // 링크 주소를 넘긴다. 퀵 노트의 문서 링크는 뒤따르는 첫 인용문도 함께 넘긴다.
  links?: boolean;
  onOpenLink?: (href: string, quote: string) => void;
  // 이 원고를 인용한 메모. 인용한 문단의 왼쪽 여백에 메모 아이콘을 달고, 누르면 onOpenNotes를 부른다.
  notes?: NoteMark[];
  onOpenNotes?: (notes: NoteMark[], at: { x: number; y: number }) => void;
  // 기본 우클릭 메뉴 대신 앱 메뉴(잘라내기·복사·붙여넣기·메모 추가·이미지 삽입·전체 선택)를 띄운다.
  contextMenu?: boolean;
  // 원고 이미지. resolve는 원고의 이미지 경로를 화면에 그릴 주소로 읽고, save는 이미지를 작품의 assets/에
  // 저장한 뒤 원고에 쓸 경로를 돌려준다(file이 없으면 파일 선택 창을 띄운다). 없으면 이미지를 넣지 않는다.
  images?: {
    resolve: (src: string) => Promise<string | null>;
    save?: SaveImage;
  };
  // 편집 중인(다른 그룹이 아니고 보이는) 원고의 커서 줄 번호를 알린다.
  onCursorLine?: (line: number) => void;
  onUndoStateChange?: (state: UndoState) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const style = normalizeEditorStyle({
    ...typingOptions,
    ...editorStyle,
    fontSize,
    lineHeight,
  });
  const mergedOptions = {
    ...typingOptions,
    hardBreakIndent: style.hardBreakIndent,
    indent: style.indent,
  };
  const optionsRef = useRef(mergedOptions);
  optionsRef.current = mergedOptions;
  const countingRulesRef = useRef(countingRules);
  countingRulesRef.current = countingRules;
  const sourceRef = useRef<SourceEditorHandle>(null);
  const undoStateCallback = useRef(onUndoStateChange);
  undoStateCallback.current = onUndoStateChange;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const protection = useRef<{ id: string; key: string; body: string; source: boolean; required: boolean } | null>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const hasImages = !!images;
  const protectionKey = `${tables}/${links}/${hasImages}`;
  const previousProtection = protection.current;
  // 로컬 입력은 통지할 때 기록한다. 전체 검사는 읽기·외부 변경·원문에서 복귀할 때만 한다.
  if (!previousProtection || previousProtection.id !== id || previousProtection.key !== protectionKey ||
      previousProtection.body !== body || (previousProtection.source && !source)) {
    protection.current = {
      id, key: protectionKey, body, source,
      required: source ? previousProtection?.id === id && previousProtection.required || false
        : requiresSource(body, { tables, links, images: hasImages }),
    };
  }
  protection.current!.source = source;
  const protectedSource = protection.current!.required;
  // 원문으로 연 문서는 필요해질 때 서식 편집기를 준비한다. 로컬 입력을 다시 읽지는 않는다.
  const loadedBody = useRef<string | null>(source || protectedSource ? null : body);
  function notifyChange(nextBody: string, delta?: ManuscriptCounts | null, markdownCopy = true) {
    if (protection.current) protection.current.body = nextBody;
    onChangeRef.current(nextBody, delta, markdownCopy);
  }
  // 초기 내용은 편집기를 새로 만들 때만 준비한다. 로컬 입력과 외부 수정은 각각 아래 갱신 경로를 쓴다.
  const initialContent = useMemo(() => splitSoftBreaks(body, !manualLineBreak), [id, tables, links, hasImages]);
  const markdown = useMemo(createCachedMarkdown, [id, tables, links, hasImages]);
  const onOpenLinkRef = useRef(onOpenLink),
    onOpenNotesRef = useRef(onOpenNotes),
    onQuickNoteRef = useRef(onQuickNote),
    lastTouchCoordsRef = useRef<{ x: number; y: number; at: number } | null>(null);
  onOpenLinkRef.current = onOpenLink;
  onOpenNotesRef.current = onOpenNotes;
  onQuickNoteRef.current = onQuickNote;
  const editable = !readOnly && !inactive;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const manualLineBreakRef = useRef(manualLineBreak);
  manualLineBreakRef.current = manualLineBreak;
  const annotationsEnabled = !inactive && visible && (!readOnly || allowReadOnlyAnnotations);
  const annotationsEnabledRef = useRef(annotationsEnabled);
  annotationsEnabledRef.current = annotationsEnabled;
  const cursorLineRef = useRef(onCursorLine);
  cursorLineRef.current = onCursorLine;
  const reportsCursor = !inactive && visible;
  const notesJson = JSON.stringify(notes || []);
  // 북마크: 최신 목록과 저장 함수, 마지막으로 깔거나 알린 목록(같으면 다시 깔지 않는다).
  const bookmarksRef = useRef(bookmarks),
    onBookmarksRef = useRef(onBookmarksChange),
    bookmarkKey = useRef<{ editor: Editor | null; key: string }>({ editor: null, key: "" });
  bookmarksRef.current = bookmarks;
  onBookmarksRef.current = onBookmarksChange;
  const bookmarksJson = JSON.stringify(bookmarks || []);
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          document: false,
          link: links
            ? {
                openOnClick: false,
                autolink: false,
                linkOnPaste: false,
                protocols: [NOTE_LINK_PROTOCOL],
                HTMLAttributes: { target: null, rel: null },
              }
            : false,
          underline: false,
        }),
        markdown.document,
        markdown.extension,
        FindHighlights,
        MarkdownTasks,
        ...(tables ? [MarkdownTables] : []),
        ...(hasImages
          ? [MarkdownImage.configure({ resolve: (src) => imagesRef.current?.resolve(src) ?? Promise.resolve(null) })]
          : []),
        TypingAssist.configure({ getOptions: () => optionsRef.current }),
        Bookmarks.configure({ canToggle: () => annotationsEnabledRef.current && !!onBookmarksRef.current }),
        NoteMarks.configure({
          onOpen: (list, event) => onOpenNotesRef.current?.(list, { x: event.clientX, y: event.clientY }),
        }),
        Placeholder.configure({
          placeholder: "이곳에서 이야기를 시작해 보세요.",
          showOnlyWhenEditable: false,
        }),
      ],
      content: source || protectedSource ? "" : initialContent,
      contentType: "markdown",
      editable,
      editorProps: {
        clipboardTextParser: manualLineBreak ? parseManualClipboardText : parseAutomaticClipboardText,
        clipboardTextSerializer: manualLineBreak ? undefined : automaticClipboardTextSerializer(copyWithBlankLines),
        transformPasted: manualLineBreak ? undefined : normalizeAutomaticHtmlPaste,
        // 그림 파일을 붙여 넣거나 끌어 놓으면 작품의 assets/에 저장하고 이미지로 넣는다.
        handlePaste: (view, event) => {
          const files = imageFiles(event.clipboardData),
            save = imagesRef.current?.save;
          if (files.length && save && view.editable) {
            event.preventDefault();
            void saveImageFiles(files, save, (img) => placeImage(view, img));
            return true;
          }
          const text = event.clipboardData?.getData("text/plain");
          return !manualLineBreakRef.current && !!text && insertAutomaticText(view, text);
        },
        handleTextInput: (view, from, to, text) =>
          !manualLineBreakRef.current && insertAutomaticText(view, text, from, to),
        handleDrop: (view, event, _slice, moved) => {
          const files = moved ? [] : imageFiles(event.dataTransfer),
            save = imagesRef.current?.save;
          if (!files.length || !save || !view.editable) return false;
          event.preventDefault();
          let at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void saveImageFiles(files, save, (img) => {
            placeImage(view, img, at);
            at = undefined;
          });
          return true;
        },
        // 이미지를 누르면 그 이미지를 골라 크기·삭제 도구를 띄운다.
        handleClickOn: (view, _pos, node, nodePos) => {
          if (node.type.name !== "image" || !view.editable) return false;
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
          return true;
        },
        attributes: {
          "aria-label": inactive ? "다른 그룹 원고 본문" : "원고 본문",
          "data-testid": visible ? (editable ? "manuscript" : "manuscript-readonly") : "",
          spellcheck: "false",
        },
        handleDOMEvents: {
          beforeinput: (view, event) => {
            if (manualLineBreakRef.current || !event.cancelable ||
              !["insertFromPaste", "insertText", "insertReplacementText"].includes(event.inputType)) return false;
            const text = event.dataTransfer?.getData("text/plain") || event.data;
            if (!text || !/[\r\n]/.test(text)) return false;
            const range = event.getTargetRanges?.()[0];
            const from = range ? view.posAtDOM(range.startContainer, range.startOffset) : view.state.selection.from;
            const to = range ? view.posAtDOM(range.endContainer, range.endOffset) : view.state.selection.to;
            if (!insertAutomaticText(view, text, from, to)) return false;
            event.preventDefault();
            return true;
          },
          // 링크를 앱 안에서 열어 WebView가 다른 페이지로 이동하지 않도록 한다.
          click: (view, event) => {
            const anchor = (event.target as HTMLElement).closest?.("a[href]");
            if (!anchor || !view.dom.contains(anchor)) return false;
            event.preventDefault();
            const href = anchor.getAttribute("href") || "";
            const id = noteLinkTarget(href);
            if ((!id && !isRelativeDocumentLink(href)) || !onOpenLinkRef.current) return true;
            onOpenLinkRef.current(href, id ? quoteAfter(view.state.doc, view.posAtDOM(anchor, 0)) : "");
            return true;
          },
          auxclick: (view, event) => {
            const anchor = (event.target as HTMLElement).closest?.("a[href]");
            if (anchor && view.dom.contains(anchor)) event.preventDefault();
            return false;
          },
          touchstart: (_view, event) => {
            const touch = event.touches[0];
            imageTouch =
              event.touches.length === 1 && (event.target as HTMLElement).closest?.(".md-image")
                ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp }
                : null;
            return false;
          },
          // 터치로 이미지를 짧게 누르면 본문에 포커스를 주지 않고 이미지만 고른다.
          // 키보드가 뜨지 않고, 키보드 입력이 선택을 바꿔 크기·삭제 도구가 듣지 않는 일도 없다.
          touchend: (view, event) => {
            const start = imageTouch, touch = event.changedTouches[0];
            imageTouch = null;
            if (!start || !touch || !view.editable || !event.cancelable) return false;
            if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10 || event.timeStamp - start.at > 500)
              return false;
            const hit = view.posAtCoords({ left: touch.clientX, top: touch.clientY });
            if (!hit || hit.inside < 0 || view.state.doc.nodeAt(hit.inside)?.type.name !== "image") return false;
            event.preventDefault();
            if (view.hasFocus()) (view.dom as HTMLElement).blur();
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hit.inside)));
            return true;
          },
        },
      },
      onUpdate: ({ editor, transaction }) => {
        if (!editableRef.current) return;
        const rules = countingRulesRef.current;
        const delta = rules ? paragraphCountDelta(transaction.before, editor.state.doc, rules) : null;
        const nextBody = markdown.serialize(editor);
        loadedBody.current = nextBody;
        notifyChange(nextBody, delta, docNeedsMarkdownCopy(editor.state.doc));
      },
      // 북마크를 넣고 빼거나, 본문이 바뀌어 북마크 문단의 순서·글이 달라지면 알린다.
      onTransaction: ({ editor, transaction: tr }) => {
        if (!onBookmarksRef.current) return;
        if (tr.getMeta(BOOKMARK_LOAD) || tr.getMeta("preventUpdate")) return;
        if (!tr.docChanged && !tr.getMeta(bookmarkPluginKey)) return;
        const list = readBookmarks(editor.state),
          key = JSON.stringify(list);
        if (key === bookmarkKey.current.key) return;
        bookmarkKey.current = { editor, key };
        onBookmarksRef.current?.(list);
      },
    },
    [id, tables, links, hasImages],
  );
  // 이 원고를 인용한 메모 목록이 바뀌면 메모 표시를 다시 단다.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(notePluginKey, JSON.parse(notesJson)).setMeta("addToHistory", false),
    );
  }, [editor, notesJson]);
  // 문서를 열 때, 그리고 목록에서 북마크를 지우는 등 밖에서 목록이 바뀌었을 때 다시 깐다.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const effective = onBookmarksChange || bookmarks ? bookmarksRef.current : [];
    const effectiveKey = JSON.stringify(effective || []);
    if (bookmarkKey.current.editor === editor && bookmarkKey.current.key === effectiveKey) return;
    bookmarkKey.current = { editor, key: effectiveKey };
    loadBookmarks(editor, effective);
  }, [editor, bookmarksJson, Boolean(onBookmarksChange)]);
  useEffect(() => {
    if (!jumpToBookmark || !editor || editor.isDestroyed) return;
    let target = -1;
    editor.state.doc.forEach((_node, offset, index) => {
      if (index === jumpToBookmark.index) target = offset;
    });
    if (target < 0) return;
    const { state, view } = editor;
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(target + 1))));
    view.focus();
    const dom = view.nodeDOM(target);
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ block: "center", behavior: "smooth" });
      dom.classList.remove("bookmark-flash");
      void dom.offsetWidth;
      dom.classList.add("bookmark-flash");
      setTimeout(() => dom.classList.remove("bookmark-flash"), 1200);
    }
  }, [jumpToBookmark?.seq, editor]);
  const inTable = useEditorState({
    editor,
    selector: ({ editor }) => !!editor?.isActive("table"),
  });
  // 고른 이미지의 너비. 이미지를 고르지 않았으면 undefined.
  const imageWidth = useEditorState({
    editor,
    selector: ({ editor }) => {
      const sel = editor?.state.selection;
      return sel instanceof NodeSelection && sel.node.type.name === "image"
        ? ((sel.node.attrs.width as number | null) ?? null)
        : undefined;
    },
  });
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.setOptions({
        editorProps: {
          ...editor.options.editorProps,
          clipboardTextParser: manualLineBreak ? parseManualClipboardText : parseAutomaticClipboardText,
          clipboardTextSerializer: manualLineBreak ? undefined : automaticClipboardTextSerializer(copyWithBlankLines),
          transformPasted: manualLineBreak ? undefined : normalizeAutomaticHtmlPaste,
        },
      });
    }
  }, [editor, manualLineBreak, copyWithBlankLines]);
  // 로컬 입력은 다시 읽지 않고, 일괄 교정 등 밖에서 바뀐 본문은 저장 전에도 반영한다.
  useEffect(() => {
    if (!editor || editor.isDestroyed || source || protectedSource) return;
    if (body === loadedBody.current) return;
    loadedBody.current = body;
    if (markdown.serialize(editor) === body) return;
    editor.commands.setContent(splitSoftBreaks(body, !manualLineBreak), {
      contentType: "markdown",
      emitUpdate: false,
    });
    // 본문을 통째로 바꾸면 붙어 있던 북마크가 사라지므로 저장된 목록으로 다시 깐다.
    bookmarkKey.current = { editor, key: JSON.stringify(bookmarksRef.current || []) };
    loadBookmarks(editor, bookmarksRef.current);
  }, [body, revision, source, protectedSource, editor, id]);
  useEffect(() => {
    if (!session || !editor || editor.isDestroyed || source || protectedSource) return;
    const saved = readEditorSelection(session, "rich", editor.state.doc.content.size);
    if (saved && !reveal?.query && !jumpToBookmark) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.between(
      editor.state.doc.resolve(saved.anchor), editor.state.doc.resolve(saved.head),
    )));
    const remember = () => {
      if (editor.isDestroyed) return;
      const { anchor, head } = editor.state.selection;
      saveEditorSelection(session, "rich", { anchor, head });
    };
    editor.on("selectionUpdate", remember);
    editor.on("update", remember);
    return () => {
      editor.off("selectionUpdate", remember);
      editor.off("update", remember);
    };
  }, [editor, id, source, protectedSource, session?.scope, session?.documentId]);
  // 강제 줄바꿈 들여쓰기 설정이 바뀌면 장식(Decoration)을 즉시 갱신한다.
  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.view) {
      editor.view.dispatch(
        editor.state.tr.setMeta(typesettingPluginKey, true),
      );
    }
  }, [
    editor,
    style.hardBreakIndent,
    style.indent,
  ]);
  // 원고 보호(집필 완료)처럼 열린 채로 읽기 전용이 바뀔 때.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
    editor.setOptions({ editorProps: {
      ...editor.options.editorProps,
      attributes: {
        ...editor.options.editorProps.attributes,
        "aria-label": inactive ? "다른 그룹 원고 본문" : "원고 본문",
        "data-testid": visible ? (editable ? "manuscript" : "manuscript-readonly") : "",
      },
    } });
    if (!editable && editor.isFocused) editor.view.dom.blur();
  }, [editor, editable, inactive, visible]);
  useLayoutEffect(() => { if (!visible || inactive) setMenu(null); }, [visible, inactive]);
  useLayoutEffect(() => {
    if (!undoStateCallback.current) return;
    if (source || protectedSource) {
      if (!sourceRef.current?.view) undoStateCallback.current({ canUndo: false, canRedo: false });
      return;
    }
    const report = () => {
      const enabled = !!editor && !editor.isDestroyed && editor.isEditable && visible && !inactive;
      undoStateCallback.current?.({
        canUndo: enabled && editor!.can().undo(),
        canRedo: enabled && editor!.can().redo(),
      });
    };
    report();
    if (!editor || editor.isDestroyed) return;
    // 되돌리기 가능 여부는 본문이 바뀔 때만 달라진다. 여백 표시 같은 꾸밈 전용 갱신은 건너뛴다.
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) report();
    };
    editor.on("transaction", onTransaction);
    return () => { editor.off("transaction", onTransaction); };
  }, [editor, source, protectedSource, visible, inactive, editable, Boolean(onUndoStateChange)]);
  // 편집 중인 원고가 되거나 원문 편집으로 바뀌면 지금 줄을 알리고, 편집기에서는 바뀔 때마다 다시 알린다.
  useEffect(() => {
    if (!reportsCursor) return;
    const sourceView = sourceRef.current?.view;
    if (sourceView) {
      cursorLineRef.current?.(sourceView.state.doc.lineAt(sourceView.state.selection.main.head).number);
      return;
    }
    if (!editor || editor.isDestroyed) return;
    const report = () => {
      if (!editor.isDestroyed) cursorLineRef.current?.(cursorLineAt(editor.state.doc, editor.state.selection.head));
    };
    report();
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; selectionSet: boolean } }) => {
      if (transaction.docChanged || transaction.selectionSet) report();
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, reportsCursor, source, protectedSource]);
  useEffect(() => {
    if (!visible || inactive || !editable) return;
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (!text) return;
      if (source || protectedSource) {
        const view = sourceRef.current?.view;
        if (view) {
          const { from, to } = view.state.selection.main;
          sourceRef.current?.replace(from, to, text);
          view.focus();
        }
      } else if (editor && !editor.isDestroyed) {
        editor.chain().focus().insertContent(text).run();
      }
    };
    const onInsertPair = (e: Event) => {
      const detail = (e as CustomEvent<{ open: string; close: string }>).detail;
      if (!detail?.open || !detail?.close) return;
      const { open, close } = detail;
      if (source || protectedSource) {
        const view = sourceRef.current?.view;
        if (view) {
          const { from, to } = view.state.selection.main;
          const selected = view.state.sliceDoc(from, to);
          sourceRef.current?.replace(from, to, `${open}${selected}${close}`);
          const nextPos = selected.length
            ? from + open.length + selected.length + close.length
            : from + open.length;
          view.dispatch({ selection: { anchor: nextPos, head: nextPos } });
          view.focus();
        }
      } else if (editor && !editor.isDestroyed) {
        const { from, to } = editor.state.selection;
        if (from === to) {
          editor
            .chain()
            .focus()
            .insertContent(`${open}${close}`)
            .setTextSelection(from + open.length)
            .run();
        } else {
          const selected = editor.state.doc.textBetween(from, to, "");
          editor.chain().focus().insertContent(`${open}${selected}${close}`).run();
        }
      }
    };
    const onAction = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (source || protectedSource) {
        const view = sourceRef.current?.view;
        if (cmd === "undo") {
          sourceRef.current?.undo(false);
          return;
        }
        if (cmd === "redo") {
          sourceRef.current?.redo(false);
          return;
        }
        if (view && cmd === "enter") {
          const { from, to } = view.state.selection.main;
          sourceRef.current?.replace(from, to, "\n");
          view.dispatch({ selection: { anchor: from + 1, head: from + 1 } });
        }
        if (view && cmd === "taskList") {
          const { from, to } = view.state.selection.main;
          const first = view.state.doc.lineAt(from);
          const last = view.state.doc.lineAt(to > from && view.state.doc.lineAt(to).from === to ? to - 1 : to);
          const lines = view.state.doc.sliceString(first.from, last.to).split("\n");
          const remove = lines.some((line) => line.trim()) &&
            lines.every((line) => !line.trim() || /^\s*[-+*]\s+\[[ xX]\](?:\s|$)/.test(line));
          const text = lines.map((line) => {
            if (!line.trim() && lines.length > 1) return line;
            if (remove) return line.replace(/^(\s*)[-+*]\s+\[[ xX]\]\s?/, "$1");
            const indent = line.match(/^\s*/)?.[0] ?? "";
            const content = line.slice(indent.length).replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "");
            return `${indent}- [ ] ${content}`;
          }).join("\n");
          sourceRef.current?.replace(first.from, last.to, text);
        }
        view?.focus();
        return;
      }
      if (!editor || editor.isDestroyed) return;
      if (cmd === "undo") editor.commands.undo();
      else if (cmd === "redo") editor.commands.redo();
      else if (cmd === "enter") editor.chain().focus().splitBlock().scrollIntoView().run();
      else if (cmd === "divider") editor.chain().focus().setHorizontalRule().run();
      else if (cmd === "heading") editor.chain().focus().toggleHeading({ level: 2 }).run();
      else if (cmd === "bold") editor.chain().focus().toggleBold().run();
      else if (cmd === "italic") editor.chain().focus().toggleItalic().run();
      else if (cmd === "strike") editor.chain().focus().toggleStrike().run();
      else if (cmd === "quote") editor.chain().focus().toggleBlockquote().run();
      else if (cmd === "bulletList") editor.chain().focus().toggleBulletList().run();
      else if (cmd === "orderedList") editor.chain().focus().toggleOrderedList().run();
      else if (cmd === "taskList") editor.chain().focus().toggleTaskList().run();
      else if (cmd === "table" && tables) editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      else if (cmd === "image") void pickImage();
      else if (cmd === "comment") toggleJsdocComment(editor.view);
      else if (cmd === "toggleLineBreak" && lineBreak) {
        convertBlankLines(editor, !manualLineBreak);
        lineBreak.onChange(!manualLineBreak);
      }
    };
    window.addEventListener("lof:insert-text", onInsert);
    window.addEventListener("lof:insert-pair", onInsertPair);
    window.addEventListener("lof:editor-action", onAction);
    return () => {
      window.removeEventListener("lof:insert-text", onInsert);
      window.removeEventListener("lof:insert-pair", onInsertPair);
      window.removeEventListener("lof:editor-action", onAction);
    };
  }, [editor, visible, inactive, editable, source, protectedSource, tables, lineBreak, manualLineBreak]);
  // 모바일(Android) 커서 핸들·길게 누르기 메뉴에 편집 상태와 동작을 연결한다.
  useEffect(() => {
    if (!visible || inactive) return;
    const bridge = () =>
      (window as any).lofAndroidEditor as
        | { setContextState?: (canBookmark: boolean, bookmarked: boolean, canQuickNote: boolean, canPaste: boolean, canComment: boolean, commented: boolean) => void }
        | undefined;

    const isSelectionInsideEditor = () => {
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLElement &&
        (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") &&
        !sourceRef.current?.view?.dom.contains(activeEl)
      ) {
        return false;
      }
      if (source || protectedSource) {
        const view = sourceRef.current?.view;
        if (!view) return false;
        const domSel = document.getSelection();
        return Boolean(
          view.hasFocus ||
            (activeEl && view.dom.contains(activeEl)) ||
            (domSel?.anchorNode && view.dom.contains(domSel.anchorNode)),
        );
      }
      if (!editor || editor.isDestroyed) return false;
      const view = editor.view;
      const domSel = view.dom.ownerDocument.getSelection();
      const hasDomSel = Boolean(domSel?.anchorNode && view.dom.contains(domSel.anchorNode));
      const recentTouch = Boolean(lastTouchCoordsRef.current && Date.now() - lastTouchCoordsRef.current.at < 2500);
      return Boolean(
        view.hasFocus() ||
          (activeEl && view.dom.contains(activeEl)) ||
          hasDomSel ||
          recentTouch,
      );
    };

    const computeState = () => {
      if (!annotationsEnabledRef.current || !isSelectionInsideEditor()) {
        return { canBookmark: false, bookmarked: false, canQuickNote: false };
      }
      if (source || protectedSource) {
        return {
          canBookmark: false,
          bookmarked: false,
          canQuickNote: Boolean(onQuickNoteRef.current),
        };
      }
      if (!editor || editor.isDestroyed) {
        return { canBookmark: false, bookmarked: false, canQuickNote: false };
      }
      const recentTouch =
        lastTouchCoordsRef.current && Date.now() - lastTouchCoordsRef.current.at < 1500
          ? lastTouchCoordsRef.current
          : null;
      const blockPos = resolveTargetBlockPos(editor.view, !editor.view.editable ? recentTouch : null);
      const canBookmark = Boolean(onBookmarksRef.current && blockPos >= 0);
      const bookmarked = canBookmark && isBookmarkedAt(editor.state, blockPos);
      const canQuickNote = Boolean(onQuickNoteRef.current);
      return { canBookmark, bookmarked, canQuickNote };
    };

    const syncState = () => {
      const native = bridge();
      if (!native?.setContextState) return;
      const next = computeState();
      const canPaste = editable && !protectedSource && isSelectionInsideEditor();
      const canComment = canPaste && (source ? !!sourceRef.current?.view : !!editor && !editor.isDestroyed && editor.isEditable);
      const commented = canComment && (source ? sourceRef.current?.isCommented() === true : isInsideJsdocComment(editor!.state));
      native.setContextState(next.canBookmark, next.bookmarked, next.canQuickNote, canPaste, canComment, commented);
      return next;
    };

    (window as any).__lofSyncEditorContextState = syncState;
    (window as any).__lofPasteEditorText = (text: string) => {
      if (!editable || protectedSource || !isSelectionInsideEditor()) return;
      if (source) {
        sourceRef.current?.paste(text);
      } else if (editor && !editor.isDestroyed && editor.isEditable) {
        editor.view.pasteText(text);
        editor.commands.focus();
      }
    };
    (window as any).__lofEditorContextAction = (action: string) => {
      if (action === "comment") {
        if (!editable || protectedSource || !isSelectionInsideEditor()) return;
        if (source) sourceRef.current?.toggleComment();
        else if (editor && !editor.isDestroyed) toggleJsdocComment(editor.view);
        syncState();
        return;
      }
      if (!annotationsEnabledRef.current) return;
      if (action === "bookmark") {
        if (source || protectedSource || !editor || editor.isDestroyed || !onBookmarksRef.current) return;
        const recentTouch =
          lastTouchCoordsRef.current && Date.now() - lastTouchCoordsRef.current.at < 2500
            ? lastTouchCoordsRef.current
            : null;
        const blockPos = resolveTargetBlockPos(editor.view, !editor.view.editable ? recentTouch : null);
        if (blockPos >= 0) {
          toggleBookmarkWithFlash(editor.view, blockPos);
          syncState();
        }
        return;
      }
      if (action === "quickNote") {
        if (!onQuickNoteRef.current) return;
        const defaultAt = () => ({
          x: Math.max(12, Math.round((window.innerWidth - Math.min(380, window.innerWidth - 32)) / 2)),
          y: Math.max(56, Math.round(window.innerHeight * 0.14)),
        });
        if (source || protectedSource) {
          const view = sourceRef.current?.view;
          if (!view) return;
          const { from, to } = view.state.selection.main;
          const selected = view.state.sliceDoc(from, to);
          const text = selected.trim() ? selected : view.state.doc.lineAt(from).text.trim();
          const coords = view.coordsAtPos(from);
          const at = coords && !window.matchMedia?.("(max-width: 760px)").matches
            ? { x: coords.left, y: coords.bottom }
            : defaultAt();
          setTimeout(() => onQuickNoteRef.current?.(text, at), 20);
          return;
        }
        if (!editor || editor.isDestroyed) return;
        const view = editor.view;
        const { from, to } = editor.state.selection;
        const domSel = view.dom.ownerDocument.getSelection();
        const domInside = Boolean(
          domSel?.anchorNode &&
            domSel.focusNode &&
            view.dom.contains(domSel.anchorNode) &&
            view.dom.contains(domSel.focusNode),
        );
        const domText = domInside && domSel && !domSel.isCollapsed ? domSel.toString() : "";
        const pmText =
          from !== to
            ? manualLineBreak
              ? editor.state.doc.textBetween(from, to, "\n")
              : view.serializeForClipboard(editor.state.selection.content()).text
            : "";
        const recentTouch =
          lastTouchCoordsRef.current && Date.now() - lastTouchCoordsRef.current.at < 2500
            ? lastTouchCoordsRef.current
            : null;
        const blockPos = resolveTargetBlockPos(view, !view.editable ? recentTouch : null);
        const blockText = blockPos >= 0 ? editor.state.doc.nodeAt(blockPos)?.textContent.trim() ?? "" : "";
        const text = domText.trim() ? domText : pmText.trim() ? pmText : blockText;
        let at = defaultAt();
        if (!window.matchMedia?.("(max-width: 760px)").matches) {
          try {
            const coords = view.coordsAtPos(from);
            at = { x: coords.left, y: coords.bottom };
          } catch {}
        }
        setTimeout(() => onQuickNoteRef.current?.(text, at), 20);
      }
    };

    syncState();
    const onSelectionChange = () => syncState();
    const onTouchStart = (e: TouchEvent) => {
      const target = e.target as Node | null;
      const touch = e.touches[0];
      const inRich = Boolean(editor && !editor.isDestroyed && target && editor.view.dom.contains(target));
      const inSource = Boolean((source || protectedSource) && target && sourceRef.current?.view?.dom.contains(target));
      if ((inRich || inSource) && touch) {
        lastTouchCoordsRef.current = { x: touch.clientX, y: touch.clientY, at: Date.now() };
      } else {
        lastTouchCoordsRef.current = null;
      }
      syncState();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("focusin", onSelectionChange);
    document.addEventListener("focusout", onSelectionChange);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    editor?.on("selectionUpdate", onSelectionChange);
    editor?.on("transaction", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("focusin", onSelectionChange);
      document.removeEventListener("focusout", onSelectionChange);
      document.removeEventListener("touchstart", onTouchStart);
      editor?.off("selectionUpdate", onSelectionChange);
      editor?.off("transaction", onSelectionChange);
      bridge()?.setContextState?.(false, false, false, false, false, false);
      if ((window as any).__lofSyncEditorContextState === syncState) {
        delete (window as any).__lofSyncEditorContextState;
        delete (window as any).__lofEditorContextAction;
        delete (window as any).__lofPasteEditorText;
      }
    };
  }, [editor, visible, inactive, editable, source, protectedSource, manualLineBreak]);
  useEffect(() => {
    if (!reveal?.query) return;
    const pattern = searchPattern(reveal.query, reveal.caseSensitive);
    if (source || protectedSource) return;
    if (!editor || editor.isDestroyed) return;
    const hits: [number, number][] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      for (const [from, to] of searchLine(node.textContent, pattern))
        hits.push([offsetToPos(node, pos, from), offsetToPos(node, pos, to)]);
      return false;
    });
    const hit = hits[reveal.index] ?? hits[hits.length - 1];
    if (hit)
      editor.chain().focus().setTextSelection({ from: hit[0], to: hit[1] }).scrollIntoView().run();
  }, [reveal?.seq, editor]);

  const baseFont = style.fontFamily || '"Malgun Gothic", "Segoe UI", sans-serif';
  const resolvedFontFamily = style.serifSymbols
    ? `"LofSerifSymbols", ${baseFont}`
    : baseFont;

  const contentVars: CSSProperties = {
    fontSize: `${style.fontSize}px`,
    lineHeight: style.lineHeight,
    fontFamily: resolvedFontFamily,
    fontWeight: style.fontWeight,
    letterSpacing: `${style.letterSpacing}em`,
    textAlign: style.textAlign as CSSProperties["textAlign"],
    ["--editor-font-family" as any]: resolvedFontFamily,
    ["--editor-font-size" as any]: `${style.fontSize}px`,
    ["--editor-font-weight" as any]: String(style.fontWeight),
    ["--editor-letter-spacing" as any]: `${style.letterSpacing}em`,
    ["--editor-line-height" as any]: String(style.lineHeight),
    ["--editor-block-gap" as any]: `${manualLineBreak ? 0 : style.blockGap}em`,
    ["--editor-indent" as any]: `${style.indent}em`,
    ["--editor-text-align" as any]: style.textAlign,
    ["--editor-divider-padding-y" as any]: `${style.dividerPaddingY}em`,
    ["--editor-divider-thickness" as any]: `${style.dividerThickness}px`,
    ["--editor-divider-text" as any]: JSON.stringify(style.dividerText),
  };

  // 집필 화면의 우클릭 메뉴. 기본 메뉴 대신 잘라내기·복사·붙여넣기·메모 추가·이미지 삽입·전체 선택을 띄운다.
  function openEditorMenu(e: MouseEvent, text: string, ops: EditorMenuOps, hasSelection: boolean) {
    if (!contextMenu) return;
    e.preventDefault();
    const selected = !!text.trim(),
      save = images?.save;
    const addImage = async (file?: { name: string; data: string }) => {
      const img = await save?.(file);
      if (img) ops.insertImage(img);
      else ops.refocus();
    };
    // 클립보드에 글이 있으면 붙여 넣기 규칙대로 넣고, 그림만 있으면 assets/에 저장해 이미지로 넣는다.
    const paste = async () => {
      const clip = await call<{ text?: string; image?: string }>("readClipboard").catch(() => ({}) as { text?: string; image?: string });
      if (clip.text) ops.pasteText(clip.text);
      else if (clip.image && save) await addImage({ name: "image.png", data: clip.image });
      else ops.refocus();
    };
    const items: MenuItem[] = [
      {
        label: "잘라내기",
        shortcut: "Ctrl+X",
        icon: <Scissors size={15} />,
        disabled: !editable || !selected,
        action: () => void navigator.clipboard.writeText(text).then(ops.cut, ops.refocus),
      },
      {
        label: "복사",
        shortcut: "Ctrl+C",
        icon: <Copy size={15} />,
        disabled: !selected,
        action: () => void navigator.clipboard.writeText(text).finally(ops.refocus),
      },
      {
        label: "붙여넣기",
        shortcut: "Ctrl+V",
        icon: <ClipboardPaste size={15} />,
        disabled: !editable,
        action: () => void paste(),
      },
      "separator",
      ...(ops.bookmark && annotationsEnabled
        ? [
            {
              label: ops.bookmark.active ? "북마크 해제" : "북마크",
              icon: <BookmarkIcon size={15} />,
              action: () => {
                ops.bookmark!.toggle();
                ops.refocus();
              },
            },
          ]
        : []),
      ...(onQuickNote
        ? [
            {
              label: "메모 추가",
              icon: <NotebookPen size={15} />,
              disabled: !annotationsEnabled,
              action: () => onQuickNote(selected ? text : (ops.fallbackQuickNoteText ?? ""), { x: e.clientX, y: e.clientY }),
            },
          ]
        : []),
      ...(save && !hasSelection
        ? [{ label: "이미지 삽입", icon: <ImagePlus size={15} />, disabled: !editable, action: () => void addImage() }]
        : []),
      "separator",
      { label: "전체 선택", shortcut: "Ctrl+A", icon: <SquareDashed size={15} />, action: ops.selectAll },
    ];
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: items.filter((item, i) => item !== "separator" || (i > 0 && items[i - 1] !== "separator")),
    });
  }
  // 도구 막대의 이미지 버튼: 파일을 골라 assets/에 저장하고 지금 커서 자리에 넣는다.
  async function pickImage() {
    if (!editable) return;
    const img = await images?.save?.();
    if (!img) return;
    if (sourceRef.current) sourceRef.current.insertImage(img);
    else if (editor && !editor.isDestroyed) placeImage(editor.view, img);
  }
  // 테마 색 변수가 .app에 있으므로 메뉴를 그 안에 띄운다.
  const selectionMenu = menu && createPortal(
    <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />,
    document.querySelector(".app") ?? document.body,
  );

  const sourceButton = onToggleSource && (
    <button type="button" aria-label="Markdown 원문 / 편집" title="Markdown 원문 / 편집"
      className={source ? "active" : ""} aria-pressed={source}
      onMouseDown={(event) => event.preventDefault()} onClick={onToggleSource}>
      <Code2 size={16} />
    </button>
  );
  if (source || protectedSource)
    return (
      <div className="source-editor">
        <EditorFind sourceRef={sourceRef} body={body} enabled={visible && !inactive} editable={editable} />
        {sourceButton && <FormatBar inactive={inactive} visible={visible}>{sourceButton}</FormatBar>}
        {protectedSource && <div className="source-hint">원문 편집</div>}
        <div onContextMenu={(event) => {
          const handle = sourceRef.current, view = handle?.view;
          if (!handle || !view) return;
          const { from, to } = view.state.selection.main;
          const reselect = () => { view.dispatch({ selection: { anchor: from, head: to } }); view.focus(); };
          openEditorMenu(event, view.state.sliceDoc(from, to), {
            cut: () => { reselect(); handle.replace(from, to, ""); },
            selectAll: () => { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); },
            refocus: reselect,
            pasteText: text => { reselect(); handle.paste(text); },
            insertImage: image => { reselect(); handle.insertImage(image); },
            fallbackQuickNoteText: view.state.doc.lineAt(from).text.trim(),
          }, from !== to);
        }}>
          <Suspense fallback={<div role="status">원문 편집기를 준비하고 있습니다…</div>}>
          <SourceEditor
            ref={sourceRef} id={id} body={body} editable={editable} inactive={inactive} visible={visible}
            session={session}
            typingOptions={typingOptions} countingRules={countingRules}
            fontFamily={resolvedFontFamily} fontWeight={style.fontWeight}
            fontSize={style.fontSize} lineHeight={style.lineHeight}
            reveal={reveal}
            onChange={notifyChange}
            onCursorLine={reportsCursor ? line => cursorLineRef.current?.(line) : undefined}
            onUndoStateChange={onUndoStateChange}
            onPasteImage={(event, insert) => {
              const files = imageFiles(event.clipboardData), save = imagesRef.current?.save;
              if (!files.length || !save || !editable) return false;
              event.preventDefault(); void saveImageFiles(files, save, insert); return true;
            }}
          />
          </Suspense>
        </div>
        {selectionMenu}
      </div>
    );
  if (!editor) return null;
  const tools = [
    {
      label: "실행 취소 (Ctrl+Z)",
      icon: Undo2,
      action: () => editor.chain().focus().undo().run(),
    },
    {
      label: "다시 실행",
      icon: Redo2,
      action: () => editor.chain().focus().redo().run(),
    },
    {
      label: "굵게",
      icon: Bold,
      active: editor.isActive("bold"),
      action: () => editor.chain().focus().toggleBold().run(),
    },
    {
      label: "기울임 (Ctrl+I)",
      icon: Italic,
      active: editor.isActive("italic"),
      action: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: "취소선",
      icon: Strikethrough,
      active: editor.isActive("strike"),
      action: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      label: "소제목",
      icon: Heading2,
      active: editor.isActive("heading"),
      action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "인용",
      icon: Quote,
      active: editor.isActive("blockquote"),
      action: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      label: "글머리 목록",
      icon: List,
      active: editor.isActive("bulletList"),
      action: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      label: "번호 목록",
      icon: ListOrdered,
      active: editor.isActive("orderedList"),
      action: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "체크리스트 (Ctrl+Shift+9)",
      icon: ListTodo,
      active: editor.isActive("taskList"),
      action: () => editor.chain().focus().toggleTaskList().run(),
    },
    {
      label: "장면 구분",
      icon: Minus,
      action: () => editor.chain().focus().setHorizontalRule().run(),
    },
    {
      label: "주석 (Ctrl+/)",
      icon: MessageSquareCode,
      active: isInsideJsdocComment(editor.state),
      action: () => toggleJsdocComment(editor.view),
    },
    ...(onReplaceSymbols && !readOnly
      ? [
          {
            label: "기호 일괄 대치 (따옴표·말줄임표 교정)",
            icon: ArrowRightLeft,
            active: false,
            action: onReplaceSymbols,
          },
        ]
      : []),
  ];
  return (
    <>
      <EditorFind editor={editor} enabled={visible && !inactive} editable={editable} />
      {/* 다른 그룹의 막대도 원래 위치에서는 표시하고 상단에 고정됐을 때만 숨긴다. */}
      <FormatBar inactive={inactive} visible={visible}>
        {sourceButton}
        {sourceButton && <i className="format-divider" />}
        {tools.map((t) => (
          <button
            key={t.label}
            aria-label={t.label}
            title={t.label}
            className={t.active ? "active" : ""}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (editable) t.action();
            }}
          >
            <t.icon size={16} />
          </button>
        ))}
        {tables && !readOnly && (
          <button
            aria-label="표 삽입"
            title="표 삽입 (3행 × 3열)"
            disabled={inTable}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (editable) editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
            }}
          >
            <Table2 size={16} />
          </button>
        )}
        {images?.save && !readOnly && (
          <button
            aria-label="이미지 삽입"
            title="이미지 삽입 (assets 폴더에 저장)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void pickImage()}
          >
            <ImagePlus size={16} />
          </button>
        )}
        {lineBreak && visible && (
          <>
            <i className="format-divider" />
            <LineBreakControl
              manual={manualLineBreak}
              def={lineBreak.def}
              defaultLabel={lineBreak.defaultLabel}
              // 본문의 빈 줄도 함께 바꾸므로, 고칠 수 없는 원고(집필 완료)에서는 바꾸지 않는다.
              disabled={readOnly}
              onChange={(manual) => {
                // 다른 그룹의 원고는 누르면 그 그룹으로 먼저 옮겨 가므로, 여기서는 고치지 않는다.
                if (!editable) return;
                if (!editor.isDestroyed) convertBlankLines(editor, manual);
                lineBreak.onChange(manual);
              }}
            />
          </>
        )}
      </FormatBar>
      {tables && editable && visible && (
        <TableControls editor={editor} active={!inactive && editable && visible} />
      )}
      {images && editable && visible && (
        <BubbleMenu
          editor={editor}
          pluginKey="imageToolbar"
          className="table-tools image-tools"
          role="toolbar"
          aria-label="이미지 편집"
          updateDelay={0}
          shouldShow={({ editor }) => {
            const sel = editor.state.selection;
            return !inactive && editor.isEditable && sel instanceof NodeSelection && sel.node.type.name === "image";
          }}
          getReferencedVirtualElement={() => {
            const dom = editor.view.nodeDOM(editor.state.selection.from);
            return dom instanceof HTMLElement ? { contextElement: dom, getBoundingClientRect: () => dom.getBoundingClientRect() } : null;
          }}
          options={{ strategy: "absolute", placement: "top", offset: 8, flip: false, shift: { padding: 8, mainAxis: true, crossAxis: false } }}
        >
          <div className="table-tools-group">
            {IMAGE_SIZES.map(([label, width]) => (
              <ImageToolButton
                key={label}
                aria-label={`이미지 크기: ${label}`}
                title={width ? `너비 ${width}px` : "원래 크기"}
                className={imageWidth === width ? "active" : ""}
                onPress={() => {
                  const { state } = editor, sel = state.selection;
                  if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") return;
                  const tr = state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, width });
                  editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, sel.from)));
                }}
              >
                <span>{label}</span>
              </ImageToolButton>
            ))}
          </div>
          <div className="table-tools-group danger">
            <ImageToolButton
              aria-label="이미지 삭제"
              title="이미지 삭제"
              onPress={() => {
                const { state } = editor, sel = state.selection;
                if (sel instanceof NodeSelection && sel.node.type.name === "image")
                  editor.view.dispatch(state.tr.deleteSelection());
              }}
            >
              <Trash2 size={14} />
              <span>삭제</span>
            </ImageToolButton>
          </div>
        </BubbleMenu>
      )}
      <EditorContent
        className={`editor-content${manualLineBreak ? " manual-break" : ""}${style.pageViewEnabled ? " page-view" : ""}${onBookmarksChange ? " bookmarkable" : ""}`}
        data-divider-style={style.dividerStyle}
        data-page-view={style.pageViewEnabled ? style.pageViewFlow : undefined}
        editor={editor}
        style={contentVars}
        onContextMenu={(e) => {
          const { from, to } = editor.state.selection;
          const nativeSelection = readOnly && allowReadOnlyAnnotations ? editor.view.dom.ownerDocument.getSelection() : null;
          const nativeText = readOnly && allowReadOnlyAnnotations
            ? nativeSelection?.anchorNode && nativeSelection.focusNode &&
              editor.view.dom.contains(nativeSelection.anchorNode) && editor.view.dom.contains(nativeSelection.focusNode)
              ? nativeSelection.toString() : ""
            : undefined;
          const text = nativeText ?? (manualLineBreak
            ? editor.state.doc.textBetween(from, to, "\n")
            : editor.view.serializeForClipboard(editor.state.selection.content()).text);
          const blockPos = resolveTargetBlockPos(editor.view, { x: e.clientX, y: e.clientY });
          const blockText = blockPos >= 0 ? editor.state.doc.nodeAt(blockPos)?.textContent.trim() ?? "" : "";
          openEditorMenu(e, text, {
            cut: () => editor.chain().focus().deleteSelection().run(),
            selectAll: () => editor.chain().focus().selectAll().run(),
            refocus: () => editor.commands.focus(),
            pasteText: (text) => {
              editor.commands.focus();
              editor.view.pasteText(text);
            },
            insertImage: (img) => placeImage(editor.view, img),
            bookmark:
              onBookmarksChange && blockPos >= 0
                ? {
                    active: isBookmarkedAt(editor.state, blockPos),
                    toggle: () => {
                      toggleBookmarkWithFlash(editor.view, blockPos);
                    },
                  }
                : undefined,
            fallbackQuickNoteText: blockText,
          }, nativeText !== undefined ? !!nativeSelection && !nativeSelection.isCollapsed : from !== to);
        }}
      />
      {selectionMenu}
    </>
  );
}

