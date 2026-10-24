import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import TagAddPopup from "./TagAddPopup";

export default function EpisodeTags({
  tags,
  editable,
  onChange,
  favorites,
  autoOpen = false,
}: {
  tags: string[];
  editable: boolean;
  onChange: (tags: string[]) => void;
  favorites?: unknown;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const dragging = useRef<string | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    if (autoOpen && editable) setOpen(true);
  }, [autoOpen, editable]);

  return (
    <div className="episode-tag-field">
      <div className="episode-tags">
        {tags.map((tag) =>
          editable ? (
            <span
              key={tag}
              className="episode-tag"
              draggable
              onDragStart={(e) => {
                dragging.current = tag;
                suppressClick.current = true;
                e.stopPropagation();
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tag);
              }}
              onDragOver={(e) => {
                if (dragging.current !== null) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                if (dragging.current === null) return;
                e.preventDefault();
                e.stopPropagation();
                const from = tags.indexOf(dragging.current),
                  to = tags.indexOf(tag);
                if (from >= 0 && to >= 0 && from !== to) {
                  const next = [...tags];
                  next.splice(from, 1);
                  next.splice(to, 0, dragging.current);
                  onChange(next);
                }
              }}
              onDragEnd={(e) => {
                e.stopPropagation();
                dragging.current = null;
                setTimeout(() => {
                  suppressClick.current = false;
                }, 200);
              }}
            >
              <span className="episode-tag-label">#{tag}</span>
              <button
                type="button"
                className="episode-tag-remove"
                aria-label={`${tag} 태그 삭제`}
                title="태그 삭제"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (suppressClick.current) return;
                  onChange(tags.filter((t) => t !== tag));
                }}
              >
                <X size={12} />
              </button>
            </span>
          ) : (
            <span key={tag} className="episode-tag">
              <span className="episode-tag-label">#{tag}</span>
            </span>
          ),
        )}
        {editable && (
          <button
            ref={addBtnRef}
            type="button"
            className={`episode-tag-add-btn${open ? " active" : ""}`}
            aria-label="태그 추가"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Plus size={12} />
            <span>태그 추가</span>
          </button>
        )}
      </div>
      {open && editable && (
        <TagAddPopup
          anchorEl={addBtnRef.current}
          tags={tags}
          favorites={favorites}
          uppercase
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
