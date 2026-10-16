import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { MenuItem } from "./ContextMenu";

const normalized = (value: string) => value.trim().toUpperCase();

export default function EpisodeTags({ tags, editable, onChange, onMenu }: {
  tags: string[];
  editable: boolean;
  onChange: (tags: string[]) => void;
  onMenu: (rect: DOMRect, items: MenuItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState("");
  const [popoverLeft, setPopoverLeft] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dragging = useRef<string | null>(null);
  const cancelEdit = useRef(false);
  const suppressClick = useRef(false);
  const popupId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const pane = root.current?.closest(".editor-scroll")?.getBoundingClientRect();
      const min = (pane?.left ?? 0) + 8;
      const max = (pane?.right ?? window.innerWidth) - 208;
      setPopoverLeft(Math.max(min, Math.min(anchor.left, max)) - anchor.left);
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open, tags.length]);

  function close(returnFocus = false) {
    setOpen(false);
    setValue("");
    setError("");
    if (returnFocus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);

  function validate(next: string, original?: string) {
    if (!next) return "태그를 입력해 주세요.";
    if (next.length > 40) return "태그는 40자까지 입력할 수 있습니다.";
    if (tags.some((tag) => tag !== original && normalized(tag) === next))
      return "이미 추가한 태그입니다.";
    if (original === undefined && tags.length >= 30) return "태그는 30개까지 추가할 수 있습니다.";
    return "";
  }
  function add() {
    const next = normalized(value);
    const problem = validate(next);
    if (problem) { setError(problem); return; }
    onChange([...tags, next]);
    close(true);
  }
  function commitEdit() {
    if (cancelEdit.current || editing === null) return;
    const next = normalized(editValue);
    const problem = validate(next, editing);
    if (problem) { setError(problem); return; }
    cancelEdit.current = true;
    if (next !== editing) onChange(tags.map((tag) => tag === editing ? next : tag));
    setEditing(null);
    setError("");
  }
  function tagMenu(e: React.MouseEvent<HTMLButtonElement>, tag: string) {
    e.preventDefault();
    if (suppressClick.current) return;
    onMenu(e.currentTarget.getBoundingClientRect(), [
      { label: "태그 수정", icon: <Pencil size={14} />, action: () => {
        cancelEdit.current = false;
        setEditing(tag);
        setEditValue(tag);
        setError("");
      } },
      { label: "태그 삭제", icon: <Trash2 size={14} />, danger: true, action: () => onChange(tags.filter((t) => t !== tag)) },
    ]);
  }

  return (
    <div className="episode-tags" ref={root}>
      {tags.map((tag) => editing === tag && editable ? (
        <input key={tag} autoFocus className="episode-tag-edit" aria-label={`${tag} 태그 수정`}
          value={editValue} maxLength={40} style={{ width: `${Math.max(editValue.length, 4)}ch` }}
          onChange={(e) => { setEditValue(e.target.value); setError(""); }}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
            if (e.key === "Escape") {
              e.preventDefault(); e.stopPropagation(); cancelEdit.current = true;
              setEditing(null); setError("");
            }
          }} />
      ) : editable ? (
        <button key={tag} type="button" className="episode-tag" title={`${tag} · 클릭하여 수정 또는 삭제`}
          aria-label={`${tag} 태그 메뉴`} draggable
          onClick={(e) => tagMenu(e, tag)} onContextMenu={(e) => tagMenu(e, tag)}
          onDragStart={(e) => {
            dragging.current = tag; suppressClick.current = true;
            e.stopPropagation(); e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", tag);
          }}
          onDragOver={(e) => {
            if (dragging.current !== null) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; }
          }}
          onDrop={(e) => {
            if (dragging.current === null) return;
            e.preventDefault(); e.stopPropagation();
            const from = tags.indexOf(dragging.current), to = tags.indexOf(tag);
            if (from >= 0 && to >= 0 && from !== to) {
              const next = [...tags]; next.splice(from, 1); next.splice(to, 0, dragging.current); onChange(next);
            }
          }}
          onDragEnd={(e) => {
            e.stopPropagation(); dragging.current = null;
            setTimeout(() => { suppressClick.current = false; }, 200);
          }}
        ><span className="episode-tag-label">{tag}</span></button>
      ) : <span key={tag} className="episode-tag" title={tag}><span className="episode-tag-label">{tag}</span></span>)}
      {editable && (
        <div className="episode-tag-add">
          <button ref={trigger} type="button" className="episode-tag" aria-label="새 태그 추가"
            title="새 태그 추가" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
            onClick={() => { if (open) close(); else { setError(""); setOpen(true); } }}>
            {!tags.length && <span>새 태그 추가</span>}<Plus size={12} />
          </button>
          {open && (
            <div id={popupId} className="episode-tag-popover" style={{ left: popoverLeft }} role="dialog" aria-label="새 태그 추가">
              <input ref={input} aria-label="새 태그 입력" placeholder="새 태그 입력 후 엔터..."
                value={value} maxLength={40} autoComplete="off" aria-invalid={!!error}
                onChange={(e) => { setValue(e.target.value); setError(""); }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") { e.preventDefault(); add(); }
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
                }} />
              {error && <p role="alert" className="episode-tag-error">{error}</p>}
            </div>
          )}
        </div>
      )}
      {!open && error && <p role="alert" className="episode-tag-error">{error}</p>}
    </div>
  );
}
