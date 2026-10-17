import { useEffect, useRef, type CSSProperties } from "react";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Undo2,
  Redo2,
  Heading2,
  Minus,
  Sparkles,
  Table2,
  BetweenHorizontalStart,
  BetweenHorizontalEnd,
  BetweenVerticalStart,
  BetweenVerticalEnd,
  Trash2,
} from "lucide-react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import { requiresSource } from "../core/text.mjs";
import {
  typingPlan,
  pairedBackspace,
  inMarkdownCode,
} from "../core/typing.mjs";
import { normalizeEditorStyle } from "../core/typesetting.mjs";
import { TypingAssist, typesettingPluginKey } from "./typing-extension";
import { MarkdownTables } from "./table-extension";
import { Bookmarks, BOOKMARK_LOAD, bookmarkPluginKey, readBookmarks, resolveBookmarks } from "./bookmark-extension";
import type { Bookmark } from "./types";
import LineBreakControl from "./LineBreakControl";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorProps } from "@tiptap/pm/view";

function compactBlankLines<T>(lines: readonly T[], isBlank: (line: T) => boolean): T[] {
  let blankCount = 0;
  return lines.filter((line) => {
    if (!isBlank(line)) {
      blankCount = 0;
      return true;
    }
    return ++blankCount % 2 === 0;
  });
}

function normalizePastedText(text: string, manual: boolean): string {
  const lines = text.split(/\r\n?|\n/);
  return (manual ? lines : compactBlankLines(lines, (line) => line.trim() === "")).join("\n");
}

function clipboardTextParser(manual: boolean): NonNullable<EditorProps["clipboardTextParser"]> {
  return (text, $context, _plainText, view) => {
    const { schema } = view.state;
    const marks = $context.marks();
    const keptLines = normalizePastedText(text, manual).split("\n");
    const paragraphs = keptLines.map((line) =>
      schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : undefined),
    );
    return new Slice(Fragment.fromArray(paragraphs), 1, 1);
  };
}

// 표 툴바는 커서 위치가 아니라 표 자체에 붙여서 셀 이동 중에도 자리가 흔들리지 않게 한다.
function selectedTableElement(editor: Editor): HTMLElement | null {
  const { node } = editor.view.domAtPos(editor.state.selection.from);
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest<HTMLElement>(".tableWrapper") ?? el?.closest<HTMLElement>("table") ?? null;
}

const parseManualClipboardText = clipboardTextParser(true);
const parseAutomaticClipboardText = clipboardTextParser(false);

// 텍스트는 위 파서에서 한 번 처리한다. HTML의 빈 문단·줄바꿈도 같은 규칙을 적용한다.
const normalizeAutomaticPaste: NonNullable<EditorProps["transformPasted"]> = (slice, _view, plain) => {
  if (plain) return slice;
  const normalize = (content: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    content.forEach((node) => {
      nodes.push(!node.isLeaf && !node.type.spec.code ? node.copy(normalize(node.content)) : node);
    });
    const hardBreak = nodes.find((node) => node.type.name === "hardBreak");
    if (hardBreak) {
      const lines: PMNode[][] = [[]];
      for (const node of nodes) {
        if (node.type.name === "hardBreak") lines.push([]);
        else lines[lines.length - 1].push(node);
      }
      const kept = compactBlankLines(lines, (line) =>
        line.every((node) => node.isText && node.text!.trim() === ""));
      return Fragment.fromArray(kept.flatMap((line, index) => index ? [hardBreak, ...line] : line));
    }
    const kept = compactBlankLines(nodes, (node) => node.type.name === "paragraph" &&
      node.content.content.every((child) => child.isText && child.text!.trim() === ""));
    // 문단이 필수인 인용·목록 항목 안에서는 최소 한 문단을 남긴다.
    return Fragment.fromArray(kept.length || !nodes.length ? kept : [nodes[0]]);
  };
  return new Slice(normalize(slice.content), slice.openStart, slice.openEnd);
};

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
// 웹소설 원고처럼 한 줄바꿈으로만 이어진 줄도 한 줄을 한 문단으로 읽는다. Markdown 규칙대로라면 이런 줄은
// 한 문단으로 합쳐져 문단 간격·들여쓰기가 첫 줄에만 붙으므로, 읽기 전에 줄 사이를 문단 구분(빈 줄)으로 바꾼다.
// 자동 관리(hardBreaks)에서는 강제 줄바꿈(줄 끝 공백 두 칸·역슬래시)으로 이어진 줄도 붙여 넣기 규칙처럼
// 한 줄을 한 문단으로 나눈다. 수동 관리에서는 강제 줄바꿈을 그대로 둔다. 코드 블록 안, 이어지는 표·인용 줄은 건드리지 않는다.
function splitSoftBreaks(markdown: string, hardBreaks: boolean): string {
  const lines = markdown.split(/\r\n?|\n/),
    fenceLine = /^\s*(```|~~~)/,
    hardEnd = /( {2,}|\\)$/,
    joined = (line: string) => /^\s*[|>]/.test(line);
  const out: string[] = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (fenceLine.test(line)) fence = !fence;
    const next = lines[i + 1],
      split =
        !fence &&
        next !== undefined &&
        !!line.trim() &&
        !!next.trim() &&
        !(joined(line) && joined(next)) &&
        (hardBreaks || !hardEnd.test(line));
    out.push(split ? line.replace(hardEnd, "") : line);
    if (split) out.push("");
  });
  return out.join("\n");
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
// 저장된 북마크를 편집기에 다시 깐다. 되돌리기 기록과 저장 대상에서는 뺀다.
function loadBookmarks(editor: Editor, list: Bookmark[] = []) {
  editor.view.dispatch(
    editor.state.tr
      .setMeta(bookmarkPluginKey, { set: resolveBookmarks(editor.state.doc, list) })
      .setMeta(BOOKMARK_LOAD, true)
      .setMeta("addToHistory", false),
  );
}
export default function Writer({
  id,
  body,
  onChange,
  fontSize,
  lineHeight,
  source,
  onComposition,
  typingOptions,
  revision,
  readOnly = false,
  reveal = null,
  manualLineBreak = false,
  editorStyle,
  onReplaceSymbols,
  tables = false,
  lineBreak,
  bookmarks,
  onBookmarksChange,
  jumpToBookmark = null,
}: {
  id: string;
  body: string;
  onChange: (body: string) => void;
  fontSize: number;
  lineHeight: number;
  source: boolean;
  onComposition: (value: boolean) => void;
  typingOptions: Record<string, any>;
  revision: string;
  // 분할 보기에서 포커스되지 않은 그룹이 쓰는 읽기 전용 표시.
  readOnly?: boolean;
  // 검색 결과로 열었을 때 본문에서 index번째 일치를 골라 보여 준다. seq가 바뀔 때마다 다시 한다.
  reveal?: { query: string; index: number; caseSensitive?: boolean; seq: number } | null;
  // 수동 줄바꿈 관리: 단락 간격 없이 Enter 한 번이 한 줄이 된다.
  manualLineBreak?: boolean;
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
}) {
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<number | null>(null);
  // 편집기에 마지막으로 읽어 들인 원고. 편집기는 줄을 문단으로 나눠 읽으므로(splitSoftBreaks) 저장 형식과
  // 편집기의 Markdown이 달라도, 같은 원고를 다시 읽어 커서가 튀지 않게 한다.
  const loadedBody = useRef(body);
  const protectedSource = requiresSource(body, { tables });
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
        StarterKit.configure({ link: false, underline: false }),
        Markdown,
        ...(tables ? [MarkdownTables] : []),
        TypingAssist.configure({ getOptions: () => optionsRef.current }),
        Bookmarks.configure({ canToggle: () => !!onBookmarksRef.current }),
        Placeholder.configure({
          placeholder: "이곳에서 이야기를 시작해 보세요.",
        }),
      ],
      content: splitSoftBreaks(body, !manualLineBreak),
      contentType: "markdown",
      editable: !readOnly,
      editorProps: {
        clipboardTextParser: manualLineBreak ? parseManualClipboardText : parseAutomaticClipboardText,
        transformPasted: manualLineBreak ? undefined : normalizeAutomaticPaste,
        attributes: {
          "aria-label": readOnly ? "다른 그룹 원고 본문" : "원고 본문",
          "data-testid": readOnly ? "manuscript-readonly" : "manuscript",
          spellcheck: "false",
        },
        handleDOMEvents: {
          compositionstart: () => {
            onComposition(true);
            return false;
          },
          compositionend: () => {
            onComposition(false);
            return false;
          },
        },
      },
      onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
      // 북마크를 넣고 빼거나, 본문이 바뀌어 북마크 문단의 순서·글이 달라지면 알린다.
      onTransaction: ({ editor, transaction: tr }) => {
        if (tr.getMeta(BOOKMARK_LOAD) || tr.getMeta("preventUpdate")) return;
        if (!tr.docChanged && !tr.getMeta(bookmarkPluginKey)) return;
        const list = readBookmarks(editor.state),
          key = JSON.stringify(list);
        if (key === bookmarkKey.current.key) return;
        bookmarkKey.current = { editor, key };
        onBookmarksRef.current?.(list);
      },
    },
    [id, tables],
  );
  // 문서를 열 때, 그리고 목록에서 북마크를 지우는 등 밖에서 목록이 바뀌었을 때 다시 깐다.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (bookmarkKey.current.editor === editor && bookmarkKey.current.key === bookmarksJson) return;
    bookmarkKey.current = { editor, key: bookmarksJson };
    loadBookmarks(editor, bookmarksRef.current);
  }, [editor, bookmarksJson]);
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
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.setOptions({
        editorProps: {
          ...editor.options.editorProps,
          clipboardTextParser: manualLineBreak ? parseManualClipboardText : parseAutomaticClipboardText,
          transformPasted: manualLineBreak ? undefined : normalizeAutomaticPaste,
        },
      });
    }
  }, [editor, manualLineBreak]);
  useEffect(() => {
    if (
      editor &&
      !editor.isDestroyed &&
      !source &&
      !protectedSource &&
      body !== loadedBody.current &&
      editor.getMarkdown() !== body &&
      !editor.view.composing
    ) {
      loadedBody.current = body;
      editor.commands.setContent(splitSoftBreaks(body, !manualLineBreak), {
        contentType: "markdown",
        emitUpdate: false,
      });
      // 본문을 통째로 바꾸면 붙어 있던 북마크가 사라지므로 저장된 목록으로 다시 깐다.
      bookmarkKey.current = { editor, key: JSON.stringify(bookmarksRef.current || []) };
      loadBookmarks(editor, bookmarksRef.current);
    }
    // Only replace editor content for a document revision or a mode transition.
    // Mirroring every local keystroke can replay a stale React effect over newer input.
  }, [revision, source, protectedSource, editor, id]);
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
  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable === readOnly)
      editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);
  useEffect(() => () => onComposition(false), []);
  useEffect(() => {
    if (pendingSelection.current !== null && textareaRef.current) {
      textareaRef.current.setSelectionRange(
        pendingSelection.current,
        pendingSelection.current,
      );
      pendingSelection.current = null;
    }
  }, [body]);
  useEffect(() => {
    if (!reveal?.query) return;
    const norm = (t: string) => (reveal.caseSensitive ? t : t.toLocaleLowerCase()),
      q = norm(reveal.query);
    const area = textareaRef.current;
    if (area) {
      const text = norm(area.value);
      let at = -1;
      for (let i = 0, from = 0; i <= reveal.index; i++) {
        const next = text.indexOf(q, from);
        if (next < 0) break;
        at = next;
        from = next + q.length;
      }
      if (at < 0) return;
      area.focus();
      area.setSelectionRange(at, at + q.length);
      // 선택한 곳이 보이도록 줄 위치만큼 스크롤한다.
      const lines = area.value.slice(0, at).split("\n").length;
      area.scrollTop = Math.max(0, (lines - 3) * (parseFloat(getComputedStyle(area).lineHeight) || 24));
      return;
    }
    if (!editor || editor.isDestroyed) return;
    const hits: [number, number][] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      const text = norm(node.textContent);
      for (let o = text.indexOf(q); o >= 0; o = text.indexOf(q, o + q.length))
        hits.push([offsetToPos(node, pos, o), offsetToPos(node, pos, o + q.length)]);
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
  };

  if (source || protectedSource)
    return (
      <div className="source-editor">
        {protectedSource && <div className="source-hint">원문 편집</div>}
        <textarea
          ref={textareaRef}
          readOnly={readOnly}
          aria-label={readOnly ? "다른 그룹 Markdown 원문" : "Markdown 원문"}
          spellCheck={false}
          value={body}
          onPaste={(event) => {
            const target = event.currentTarget;
            const start = target.selectionStart;
            if (manualLineBreak || readOnly || inMarkdownCode(body.slice(0, start))) return;
            const text = event.clipboardData.getData("text/plain");
            const normalized = normalizePastedText(text, false);
            if (!text || normalized === text) return;
            event.preventDefault();
            const end = target.selectionEnd;
            if (!document.execCommand("insertText", false, normalized)) {
              pendingSelection.current = start + normalized.length;
              onChange(body.slice(0, start) + normalized + body.slice(end));
            }
          }}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey)
              return;
            const target = e.currentTarget,
              { selectionStart: start, selectionEnd: end } = target,
              current = target.value;
            const before = current.slice(0, start),
              after = current.slice(end),
              options = { ...typingOptions, inCode: inMarkdownCode(before) };
            const replace = (
              from: number,
              to: number,
              insert: string,
              caret: number,
            ) => {
              target.setSelectionRange(from, to);
              pendingSelection.current = caret;
              if (!document.execCommand("insertText", false, insert))
                onChange(current.slice(0, from) + insert + current.slice(to));
              target.setSelectionRange(caret, caret);
            };
            if (
              e.key === "Backspace" &&
              start === end &&
              pairedBackspace(before, after, options)
            ) {
              e.preventDefault();
              replace(start - 1, end + 1, "", start - 1);
              return;
            }
            const plan = typingPlan(
              before,
              current.slice(start, end),
              after,
              e.key,
              options,
            );
            if (!plan) return;
            e.preventDefault();
            if (plan.skip) {
              target.setSelectionRange(start + plan.skip, start + plan.skip);
              return;
            }
            const pos = start - plan.deleteBefore;
            const endPos = end + (plan.deleteAfter || 0);
            replace(pos, endPos, plan.insert, pos + plan.caret);
          }}
          onCompositionStart={() => onComposition(true)}
          onCompositionEnd={() => onComposition(false)}
          style={{ fontSize: style.fontSize, lineHeight: style.lineHeight }}
        />
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
      label: "장면 구분",
      icon: Minus,
      action: () => editor.chain().focus().setHorizontalRule().run(),
    },
    ...(onReplaceSymbols && !readOnly
      ? [
          {
            label: "기호 일괄 대치 (따옴표·말줄임표 교정)",
            icon: Sparkles,
            active: false,
            action: onReplaceSymbols,
          },
        ]
      : []),
  ];
  return (
    <>
      <div className="format-bar">
        {tools.map((t) => (
          <button
            key={t.label}
            aria-label={t.label}
            title={t.label}
            className={t.active ? "active" : ""}
            onMouseDown={(e) => e.preventDefault()}
            onClick={t.action}
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
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            <Table2 size={16} />
          </button>
        )}
        {lineBreak && (
          <>
            <i className="format-divider" />
            <LineBreakControl
              manual={manualLineBreak}
              def={lineBreak.def}
              defaultLabel={lineBreak.defaultLabel}
              // 본문의 빈 줄도 함께 바꾸므로, 고칠 수 없는 원고(집필 완료)에서는 바꾸지 않는다.
              disabled={readOnly}
              onChange={(manual) => {
                if (!editor.isDestroyed) convertBlankLines(editor, manual);
                lineBreak.onChange(manual);
              }}
            />
          </>
        )}
        <span>본문</span>
      </div>
      {tables && !readOnly && (
        <BubbleMenu
          editor={editor}
          pluginKey="tableToolbar"
          className="table-tools"
          role="toolbar"
          aria-label="표 편집 (Tab: 다음 셀 · Shift+Tab: 이전 셀)"
          updateDelay={0}
          shouldShow={({ editor }) => editor.isEditable && editor.isActive("table")}
          getReferencedVirtualElement={() => {
            const table = selectedTableElement(editor);
            return table && { getBoundingClientRect: () => table.getBoundingClientRect() };
          }}
          options={{ placement: "top-start", offset: 6, flip: true, shift: { padding: 8 } }}
        >
          {[
            [
              { label: "위에 행 추가", icon: BetweenHorizontalStart, action: () => editor.chain().focus().addRowBefore().run() },
              { label: "아래에 행 추가", icon: BetweenHorizontalEnd, action: () => editor.chain().focus().addRowAfter().run() },
            ],
            [
              { label: "왼쪽에 열 추가", icon: BetweenVerticalStart, action: () => editor.chain().focus().addColumnBefore().run() },
              { label: "오른쪽에 열 추가", icon: BetweenVerticalEnd, action: () => editor.chain().focus().addColumnAfter().run() },
            ],
            [
              { label: "행 삭제", text: "행", action: () => editor.chain().focus().deleteRow().run() },
              { label: "열 삭제", text: "열", action: () => editor.chain().focus().deleteColumn().run() },
              { label: "표 삭제", text: "표", action: () => editor.chain().focus().deleteTable().run() },
            ],
          ].map((group, i) => (
            <div key={i} className={`table-tools-group${i === 2 ? " danger" : ""}`}>
              {group.map((tool) => (
                <button
                  key={tool.label}
                  aria-label={tool.label}
                  title={tool.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={tool.action}
                >
                  {"icon" in tool && tool.icon ? <tool.icon size={16} /> : <Trash2 size={14} />}
                  {"text" in tool && <span>{tool.text}</span>}
                </button>
              ))}
            </div>
          ))}
        </BubbleMenu>
      )}
      <EditorContent
        className={`editor-content${manualLineBreak ? " manual-break" : ""}${style.pageViewEnabled ? " page-view" : ""}${onBookmarksChange ? " bookmarkable" : ""}`}
        data-divider-style={style.dividerStyle}
        data-page-view={style.pageViewEnabled ? style.pageViewFlow : undefined}
        editor={editor}
        style={contentVars}
      />
    </>
  );
}

