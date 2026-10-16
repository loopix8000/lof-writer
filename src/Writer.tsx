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
  Pilcrow,
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
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
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
  onToggleTypographicMarks,
  onReplaceSymbols,
  tables = false,
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
  onToggleTypographicMarks?: () => void;
  onReplaceSymbols?: () => void;
  tables?: boolean;
}) {
  const style = normalizeEditorStyle({
    ...typingOptions,
    ...editorStyle,
    fontSize,
    lineHeight,
  });
  const mergedOptions = {
    ...typingOptions,
    showTypographicMarks: style.showTypographicMarks,
    hardBreakIndent: style.hardBreakIndent,
    indent: style.indent,
  };
  const optionsRef = useRef(mergedOptions);
  optionsRef.current = mergedOptions;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<number | null>(null);
  const protectedSource = requiresSource(body, { tables });
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ link: false, underline: false }),
        Markdown,
        ...(tables ? [MarkdownTables] : []),
        TypingAssist.configure({ getOptions: () => optionsRef.current }),
        Placeholder.configure({
          placeholder: "이곳에서 이야기를 시작해 보세요.",
        }),
      ],
      content: body,
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
    },
    [id, tables],
  );
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
      editor.getMarkdown() !== body &&
      !editor.view.composing
    )
      editor.commands.setContent(body, {
        contentType: "markdown",
        emitUpdate: false,
      });
    // Only replace editor content for a document revision or a mode transition.
    // Mirroring every local keystroke can replay a stale React effect over newer input.
  }, [revision, source, protectedSource, editor, id]);
  // 조판 부호 표시(¶, ↵)나 강제 줄바꿈 들여쓰기 설정이 바뀌면 장식(Decoration)을 즉시 갱신한다.
  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.view) {
      editor.view.dispatch(
        editor.state.tr.setMeta(typesettingPluginKey, true),
      );
    }
  }, [
    editor,
    style.showTypographicMarks,
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
    ...(onToggleTypographicMarks
      ? [
          {
            label: "조판 부호 표시 (¶ · ↵)",
            icon: Pilcrow,
            active: style.showTypographicMarks,
            action: onToggleTypographicMarks,
          },
        ]
      : []),
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
        className={`editor-content${manualLineBreak ? " manual-break" : ""}${style.pageViewEnabled ? " page-view" : ""}`}
        data-divider-style={style.dividerStyle}
        data-page-view={style.pageViewEnabled ? style.pageViewFlow : undefined}
        editor={editor}
        style={contentVars}
      />
    </>
  );
}

