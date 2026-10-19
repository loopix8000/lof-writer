import { useRef, useState } from "react";
import { X } from "lucide-react";
import TagSuggestions from "./TagSuggestions";

const normalized = (value: string) => value.trim().toUpperCase();

export default function EpisodeTags({ tags, editable, onChange, favorites }: {
  tags: string[];
  editable: boolean;
  onChange: (tags: string[]) => void;
  favorites?: unknown;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const composing = useRef(false);
  const dragging = useRef<string | null>(null);
  const suppressClick = useRef(false);

  function validate(next: string, current: string[]) {
    if (!next) return "태그를 입력해 주세요.";
    if (next.length > 40) return "태그는 40자까지 입력할 수 있습니다.";
    if (current.some((tag) => normalized(tag) === next))
      return "이미 추가한 태그입니다.";
    if (current.length >= 30) return "태그는 30개까지 추가할 수 있습니다.";
    return "";
  }
  function add(raw: string, complete = false) {
    const parts = raw.split(/[,，\r\n]+/);
    const remainder = complete ? "" : parts.pop()!;
    const next = [...tags];
    for (const part of parts) {
      const tag = normalized(part);
      if (!tag) continue;
      const problem = validate(tag, next);
      if (problem) { setValue(raw); setError(problem); return; }
      next.push(tag);
    }
    if (next.length !== tags.length) onChange(next);
    setValue(remainder);
    setError("");
  }

  return (
    <div className="episode-tag-field">
    <div className={`episode-tags${editable ? " is-editable" : ""}`}>
      {tags.map((tag) => editable ? (
        <span key={tag} className="episode-tag" draggable
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
        ><span className="episode-tag-label">{tag}</span>
          <button type="button" className="episode-tag-remove" aria-label={`${tag} 태그 삭제`} title="태그 삭제"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (suppressClick.current) return;
              onChange(tags.filter((t) => t !== tag));
              setError("");
            }}><X size={12} /></button>
        </span>
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
