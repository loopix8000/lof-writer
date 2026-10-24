import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { GripHorizontal, NotebookPen, X } from "lucide-react";
import { escapeLinkText, noteLink } from "./note-links";

// 퀵 노트: 본문에서 고른 문장과 그때 떠오른 생각을 한 메모 문서로 저장한다.
export type QuickNoteSource = {
  projectId: string;
  // 문장을 고른 문서와 그 제목. 메모의 출처 링크로 남긴다.
  docId: string;
  title: string;
  text: string;
  // 새 메모를 연결할 회차(회차에서 골랐으면 그 회차, 플롯·메모에서 골랐으면 그 문서의 회차).
  episodeId?: string;
  // 창을 띄울 화면 위치(본문을 우클릭한 곳).
  at: { x: number; y: number };
};

// 줄 맨 앞의 Markdown 블록 기호가 제목·목록으로 읽히지 않게 막는다.
const escapeLine = (line: string) => line.replace(/^(\s*)(#{1,6}\s|[-+*]\s|\d+[.)]\s|>)/, "$1\\$2");

// 입력한 제목을 쓰고, 없으면 메모 첫 줄을 제목으로 쓴다. 메모도 비어 있으면 출처 제목으로 이름을 붙인다.
export function quickNoteTitle(source: QuickNoteSource, memo: string, input = ""): string {
  if (input.trim()) return input.trim();
  const first = memo.split(/\r\n?|\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const title = first.replace(/[.!?。…]+$/, "");
  if (!title) return `${source.title || "제목 없음"} 메모`;
  return [...title].length > 30 ? [...title].slice(0, 30).join("") + "…" : title;
}

// 출처는 원래 문서로 가는 링크로 남긴다. 선택한 문장은 한 줄을 한 문단으로 인용하고, 메모는 그대로 아래에 붙인다.
export function quickNoteMarkdown(source: QuickNoteSource, memo: string): string {
  const quote = source.text
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `> ${escapeLine(line)}`)
    .join("\n>\n");
  const parts = [
    `출처: [${escapeLinkText(source.title || "제목 없음")}](${noteLink(source.docId)})`,
  ];
  if (quote) parts.push("## 선택한 본문", quote);
  const note = memo.trim();
  if (note) parts.push("## 메모", note);
  return parts.join("\n\n") + "\n";
}

export default function QuickNote({
  source,
  onSave,
  onClose,
}: {
  source: QuickNoteSource;
  onSave: (memo: string, title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [memo, setMemo] = useState(""),
    // 비워 두면 저장할 때 제목을 자동으로 붙인다(입력칸에 미리 보여 준다).
    [title, setTitle] = useState(""),
    [saving, setSaving] = useState(false),
    // 창 자리. 우클릭한 곳 오른쪽 아래에 열고, 머리 부분을 끌어 옮긴다.
    [pos, setPos] = useState({ left: source.at.x, top: source.at.y });
  const ref = useRef<HTMLDivElement>(null),
    textRef = useRef<HTMLTextAreaElement>(null),
    drag = useRef<{ dx: number; dy: number } | null>(null);
  const clamp = (left: number, top: number) => {
    const { width, height } = ref.current!.getBoundingClientRect();
    return {
      left: Math.max(4, Math.min(left, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(top, window.innerHeight - height - 4)),
    };
  };
  useLayoutEffect(() => {
    setPos(clamp(source.at.x + 12, source.at.y + 12));
    textRef.current?.focus({ preventScroll: true });
    const onResize = () => {
      if (!ref.current) return;
      setPos((prev) => clamp(prev.left, prev.top));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [source]);
  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(memo, title);
    } finally {
      setSaving(false);
    }
  }
  function startDrag(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const rect = ref.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function moveDrag(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current || !ref.current) return;
    setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  }
  return (
    <div
      ref={ref}
      className="quick-note"
      role="dialog"
      aria-label="퀵 노트"
      style={pos}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div
        className="quick-note-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <NotebookPen size={16} />
        <strong>퀵 노트</strong>
        <GripHorizontal size={15} className="quick-note-grip" aria-hidden="true" />
        <button aria-label="닫기" title="닫기 (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="quick-note-source">{source.title || "제목 없음"}</div>
      <label className="quick-note-label" htmlFor="quick-note-title">
        제목
      </label>
      <input
        id="quick-note-title"
        className="quick-note-title"
        value={title}
        placeholder={quickNoteTitle(source, memo)}
        spellCheck={false}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          // Enter는 메모 입력으로 넘어간다(Ctrl+Enter는 저장).
          if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          textRef.current?.focus();
        }}
      />
      {source.text.trim() && (
        <>
          <div className="quick-note-label">선택한 본문</div>
          <blockquote className="quick-note-quote">{source.text}</blockquote>
        </>
      )}
      <label className="quick-note-label" htmlFor="quick-note-memo">
        메모
      </label>
      <textarea
        id="quick-note-memo"
        ref={textRef}
        value={memo}
        placeholder="떠오른 생각을 적어 보세요."
        spellCheck={false}
        onChange={(e) => setMemo(e.target.value)}
      />
      <div className="quick-note-foot">
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={saving} title="메모 저장 (Ctrl+Enter)" onClick={() => void save()}>
          메모 저장
        </button>
      </div>
    </div>
  );
}
