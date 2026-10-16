import { useEffect, useRef, useState, type ReactNode } from "react";

const MIN_WIDTH = 180;
const MAX_WIDTH = 600;

export default function ResizableSidebar({ children, className = "", label, width, onResize, active = true }: {
  children: ReactNode;
  className?: string;
  label: string;
  width?: number;
  onResize: (width: number) => void;
  active?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; start: number } | null>(null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  const [defaultWidth, setDefaultWidth] = useState(241);
  const preferredWidth = typeof width === "number" && Number.isFinite(width) ? width : defaultWidth;
  const clamp = (value: number) => Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, value)));
  const shownWidth = clamp(draftWidth ?? preferredWidth);

  useEffect(() => {
    const container = root.current?.parentElement;
    if (!container) return;
    const update = () => {
      if (!container.clientWidth) return;
      setMaxWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(container.clientWidth / 2))));
      setDefaultWidth(window.innerWidth <= 1250 ? 216 : 241);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  function cancelDrag() {
    drag.current = null;
    setDraftWidth(null);
    document.body.classList.remove("sidebar-resizing");
  }
  useEffect(() => {
    if (!active) cancelDrag();
  }, [active]);
  useEffect(() => {
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("blur", cancelDrag);
      document.body.classList.remove("sidebar-resizing");
    };
  }, []);

  return (
    <div ref={root} className={`resizable-sidebar${draftWidth !== null ? " resizing" : ""}`}
      style={{ width: shownWidth }}>
      <aside className={`file-sidebar ${className}`}>{children}</aside>
      <div className="sidebar-sash" role="separator" tabIndex={0}
        aria-label={`${label} 너비 조절`} aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={shownWidth}
        title="드래그하여 너비 조절 · 더블클릭하여 기본 너비 복원"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          const start = root.current?.getBoundingClientRect().width ?? shownWidth;
          drag.current = { id: event.pointerId, x: event.clientX, start };
          setDraftWidth(start);
          event.currentTarget.setPointerCapture(event.pointerId);
          document.body.classList.add("sidebar-resizing");
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          setDraftWidth(clamp(current.start + event.clientX - current.x));
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          const next = clamp(current.start + event.clientX - current.x);
          cancelDrag();
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (next !== Math.round(current.start)) onResize(next);
        }}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
        onDoubleClick={() => onResize(clamp(defaultWidth))}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            event.stopPropagation();
            cancelDrag();
            return;
          }
          const step = event.shiftKey ? 50 : 10;
          const next = event.key === "ArrowLeft" ? shownWidth - step
            : event.key === "ArrowRight" ? shownWidth + step
            : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth : null;
          if (next === null || drag.current) return;
          event.preventDefault();
          event.stopPropagation();
          onResize(clamp(next));
        }} />
    </div>
  );
}
