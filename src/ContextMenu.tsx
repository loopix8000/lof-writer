import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";

export type MenuItem =
  | "separator"
  | {
      label: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      // 값이 있으면 항목 앞에 선택 표시 칸을 둔다(true면 체크).
      checked?: boolean;
      // 항목 앞 아이콘, 뒤의 작은 배지(예: '원고 보호'), 마우스를 올리면 뜨는 설명.
      icon?: ReactNode;
      badge?: string;
      hint?: string;
      action: () => void;
    };

// VS Code식 우클릭 메뉴: 화면 밖으로 넘치지 않게 위치를 잡고,
// 바깥 클릭·Escape·창 크기 변경·스크롤 시 닫힌다. 방향키로 항목을 옮긴다.
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    const blur = () => onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("resize", blur);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", blur);
      window.removeEventListener("blur", blur);
    };
  }, [onClose]);
  function keydown(e: React.KeyboardEvent) {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) || []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) =>
      buttons[(to + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(buttons.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={pos}
      onKeyDown={keydown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="context-separator" role="separator" />
        ) : (
          <button
            key={i}
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            {item.checked !== undefined && (
              <i className="menu-check">{item.checked && <Check size={14} />}</i>
            )}
            {item.icon && <i className="menu-icon">{item.icon}</i>}
            <span>{item.label}</span>
            {item.badge && <em className="menu-badge">{item.badge}</em>}
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
