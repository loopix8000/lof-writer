import { useEffect, useRef, type CSSProperties } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
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
} from "lucide-react";
import { requiresSource } from "../core/text.mjs";
import {
  typingPlan,
  pairedBackspace,
  inMarkdownCode,
} from "../core/typing.mjs";
import { normalizeEditorStyle } from "../core/typesetting.mjs";
import { TypingAssist, typesettingPluginKey } from "./typing-extension";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorProps } from "@tiptap/pm/view";

function clipboardTextParser(manual: boolean): NonNullable<EditorProps["clipboardTextParser"]> {
  return (text, $context, _plainText, view) => {
    const { schema } = view.state;
    const marks = $context.marks();
    const lines = text.split(/\r\n?|\n/);
    // 수동은 원문을 보존하고, 자동은 연속된 빈 줄을 한 줄만 남긴다.
    const keptLines = manual ? lines : lines.filter((line, index) =>
      line.trim() !== "" || index === 0 || lines[index - 1].trim() !== "",
    );
    const paragraphs = keptLines.map((line) =>
      schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : undefined),
    );
    return new Slice(Fragment.fromArray(paragraphs), 1, 1);
  };
}

const parseManualClipboardText = clipboardTextParser(true);
const parseAutomaticClipboardText = clipboardTextParser(false);

// HTML 붙여넣기도 서식은 유지하면서 연속된 빈 문단만 한 문단으로 합친다.
const normalizeAutomaticPaste: NonNullable<EditorProps["transformPasted"]> = (slice) => {
  const normalize = (content: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    let previousBlank = false;
    content.forEach((node) => {
      const blank = node.type.name === "paragraph" &&
        node.content.content.every((child) => child.isText && child.text!.trim() === "");
      if (blank && previousBlank) return;
      previousBlank = blank;
      nodes.push(!node.isLeaf && !node.type.spec.code ? node.copy(normalize(node.content)) : node);
    });
    return Fragment.fromArray(nodes);
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
  const protectedSource = requiresSource(body);
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ link: false, underline: false }),
        Markdown,
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
    [id],
  );
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
        <span>본문</span>
      </div>
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

