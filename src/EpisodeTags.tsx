import { useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { MenuItem } from "./ContextMenu";
import TagSuggestions from "./TagSuggestions";

const normalized = (value: string) => value.trim().toUpperCase();

export default function EpisodeTags({ tags, editable, onChange, onMenu, favorites }: {
  tags: string[];
  editable: boolean;
  onChange: (tags: string[]) => void;
  onMenu: (rect: DOMRect, items: MenuItem[]) => void;
  favorites?: unknown;
}) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState("");
  const composing = useRef(false);
  const dragging = useRef<string | null>(null);
  const cancelEdit = useRef(false);
  const suppressClick = useRef(false);

  function validate(next: string, original?: string, current = tags) {
    if (!next) return "태그를 입력해 주세요.";
    if (next.length > 40) return "태그는 40자까지 입력할 수 있습니다.";
    if (current.some((tag) => tag !== original && normalized(tag) === next))
      return "이미 추가한 태그입니다.";
    if (original === undefined && current.length >= 30) return "태그는 30개까지 추가할 수 있습니다.";
    return "";
  }
  function add(raw: string, complete = false) {
    const parts = raw.split(/[,，\r\n]+/);
    const remainder = complete ? "" : parts.pop()!;
    const next = [...tags];
    for (const part of parts) {
      const tag = normalized(part);
      if (!tag) continue;
      const problem = validate(tag, undefined, next);
      if (problem) { setValue(raw); setError(problem); return; }
      next.push(tag);
    }
    if (next.length !== tags.length) onChange(next);
    setValue(remainder);
    setError("");
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
    <div className="episode-tag-field">
    <div className={`episode-tags${editable ? " is-editable" : ""}`}>
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
        <button key={tag} type="button" className="episode-tag"
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
      ) : <span key={tag} className="episode-tag"><span className="episode-tag-label">{tag}</span></span>)}
      {editable && (
        <input className="episode-tag-input" aria-label="새 태그 입력" placeholder="태그 입력 후 콤마"
          value={value} autoComplete="off" aria-invalid={!!error}
          onChange={(e) => {
            if (composing.current) { setValue(e.target.value); setError(""); }
            else add(e.target.value);
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; add(e.currentTarget.value); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
            if (e.key === "Enter" || e.key === "," || e.key === "，") {
              e.preventDefault(); add(value, true);
            }
            if (e.key === "Escape") {
              e.preventDefault(); e.stopPropagation(); setValue(""); setError("");
            }
          }} />
      )}
      {error && <p role="alert" className="episode-tag-error">{error}</p>}
    </div>
    {editable && <TagSuggestions tags={tags} favorites={favorites} query={value} onSelect={(tag) => add(tag, true)} />}
    </div>
  );
}
