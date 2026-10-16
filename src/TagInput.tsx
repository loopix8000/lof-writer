import { useState } from "react";
import { X, Plus } from "lucide-react";
export default function TagInput({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [value, setValue] = useState(""),
    [error, setError] = useState("");
  function add() {
    const next = [
      ...new Set([
        ...tags,
        ...value
          .split(/[,，\n]/)
          .map((t) => t.trim().replace(/^#+/, ""))
          .filter(Boolean),
      ]),
    ];
    if (next.length > 30 || next.some((t) => t.length > 40)) {
      setError("태그는 30개까지, 각 40자까지 입력할 수 있습니다.");
      return;
    }
    onChange(next);
    setValue("");
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
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value.trim()) add();
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
            if (e.key === "Backspace" && !value) onChange(tags.slice(0, -1));
          }}
        />
        <button type="button" aria-label="태그 추가" onClick={add}>
          <Plus size={15} />
        </button>
      </div>
      {error && <p className="input-error">{error}</p>}
    </div>
  );
}
