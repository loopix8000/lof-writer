import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import TagSuggestions from "./TagSuggestions";

export default function TagAddPopup({
  anchorEl,
  tags,
  favorites,
  uppercase = false,
  maxTags = 30,
  onChange,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  tags: string[];
  favorites?: unknown;
  uppercase?: boolean;
  maxTags?: number | null;
  onChange: (tags: string[]) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 12, top: 12 });
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const normalizeTag = (raw: string) => {
    const trimmed = raw.trim().replace(/^#+/, "").trim();
    return uppercase ? trimmed.toUpperCase() : trimmed;
  };

  function validate(nextTag: string, current: string[]) {
    if (!nextTag) return "태그를 입력해 주세요.";
    if (nextTag.length > 40) return "태그는 40자까지 입력할 수 있습니다.";
    if (current.some((tag) => tag.toUpperCase() === nextTag.toUpperCase())) {
      return "이미 추가한 태그입니다.";
    }
    if (maxTags !== null && current.length >= maxTags) {
      return `태그는 ${maxTags}개까지 추가할 수 있습니다.`;
    }
    return "";
  }

  function add(raw = value, complete = false) {
    const parts = raw.split(/[,，\r\n]+/);
    const remainder = complete ? "" : parts.pop()!;
    const next = [...tags];
    for (const part of parts) {
      const tag = normalizeTag(part);
      if (!tag) continue;
      const problem = validate(tag, next);
      if (problem) {
        setValue(raw);
        setError(problem);
        return;
      }
      next.push(tag);
    }
    if (next.length !== tags.length) onChange(next);
    setValue(remainder);
    setError("");
  }

  useLayoutEffect(() => {
    const updatePosition = () => {
      const pop = popupRef.current;
      if (!pop) return;
      const popRect = pop.getBoundingClientRect();
      const anchorRect = anchorEl?.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = anchorRect ? anchorRect.left : Math.round((vw - popRect.width) / 2);
      let top = anchorRect ? anchorRect.bottom + 6 : Math.round(vh * 0.2);
      if (anchorRect && top + popRect.height > vh - 8 && anchorRect.top - popRect.height - 6 >= 8) {
        top = anchorRect.top - popRect.height - 6;
      }
      left = Math.max(8, Math.min(left, vw - popRect.width - 8));
      top = Math.max(8, Math.min(top, vh - popRect.height - 8));
      setPos({ left, top });
    };
    updatePosition();
    inputRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorEl, tags.length, error]);

  useEffect(() => {
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popupRef.current?.contains(target) || anchorEl?.contains(target)) return;
      closeRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorEl]);

  return createPortal(
    <div
      ref={popupRef}
      className="tag-add-popup"
      role="dialog"
      aria-label="태그 추가"
      style={pos}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tag-add-popup-row">
        <input
          ref={inputRef}
          type="text"
          className="tag-add-popup-input"
          aria-label="새 태그 입력"
          placeholder="태그 입력 후 Enter 또는 쉼표"
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          onChange={(e) => {
            if (composing.current) {
              setValue(e.target.value);
              setError("");
            } else {
              add(e.target.value, false);
            }
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            add(e.currentTarget.value, false);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
            if (e.key === "Enter" || e.key === "," || e.key === "，") {
              e.preventDefault();
              if (!value.trim() && e.key === "Enter") {
                onClose();
                return;
              }
              add(value, true);
            }
          }}
        />
        <button
          type="button"
          className="tag-add-popup-btn"
          aria-label="태그 추가"
          title="태그 추가"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!value.trim()) {
              inputRef.current?.focus();
              return;
            }
            add(value, true);
          }}
        >
          <Plus size={15} />
        </button>
      </div>
      {error && (
        <p role="alert" className="episode-tag-error">
          {error}
        </p>
      )}
      <TagSuggestions
        tags={tags}
        favorites={favorites}
        query={value}
        onSelect={(tag) => add(tag, true)}
      />
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}
