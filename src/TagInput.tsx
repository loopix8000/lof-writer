import { useRef, useState } from "react";
import { X, Plus } from "lucide-react";
import TagSuggestions from "./TagSuggestions";
export default function TagInput({
  tags,
  onChange,
  favorites,
  maxTags = 30,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  favorites?: unknown;
  maxTags?: number | null;
}) {
  const [value, setValue] = useState(""),
    [error, setError] = useState("");
  const composing = useRef(false);
  function add(raw = value, complete = true) {
    const parts = raw.split(/[,，\r\n]+/);
    const remainder = complete ? "" : parts.pop()!;
    const next = [
      ...new Set([
        ...tags,
        ...parts
          .map((t) => t.trim().replace(/^#+/, ""))
          .filter(Boolean),
      ]),
    ];
    if ((maxTags !== null && next.length > maxTags) || next.some((t) => t.length > 40)) {
      setValue(raw);
      setError(maxTags === null ? "태그는 각 40자까지 입력할 수 있습니다." : `태그는 ${maxTags}개까지, 각 40자까지 입력할 수 있습니다.`);
      return;
    }
    if (next.length !== tags.length) onChange(next);
    setValue(remainder);
    setError("");
  }
  return (
    <div className="tag-editor">
      <div className="tag-chips">
        {tags.map((t) => (
          <span key={t} className="tag-chip">
            #{t}
            <button
              type="button"
              aria-label={`${t} 태그 제거`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-entry">
        <input
          aria-label="태그 입력"
          placeholder="태그 입력 후 Enter 또는 쉼표"
          value={value}
          maxLength={500}
          onChange={(e) => {
            if (composing.current) { setValue(e.target.value); setError(""); }
            else add(e.target.value, false);
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; add(e.currentTarget.value, false); }}
          onBlur={() => {
            if (!composing.current && value.trim()) add();
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
            if (e.key === "Enter" || e.key === "," || e.key === "，") {
              e.preventDefault();
              add();
            }
            if (e.key === "Backspace" && !value) onChange(tags.slice(0, -1));
          }}
        />
        <button type="button" aria-label="태그 추가" onMouseDown={(e) => e.preventDefault()} onClick={() => add()}>
          <Plus size={15} />
        </button>
      </div>
      <TagSuggestions tags={tags} favorites={favorites} query={value} onSelect={(tag) => add(tag)} />
      {error && <p className="input-error">{error}</p>}
    </div>
  );
}
