import type { CSSProperties, ReactNode } from "react";

export type PillTabItem<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
  onDragEnter?: () => void;
};

export default function PillTabs<T extends string>({
  value,
  items,
  onChange,
  label,
  className,
}: {
  value: T;
  items: readonly PillTabItem<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const selectedIndex = items.findIndex((item) => item.value === value);
  return (
    <div
      className={`m-pill-tabs${className ? ` ${className}` : ""}`}
      role="tablist"
      aria-label={label}
      style={
        {
          "--pill-count": items.length,
          "--pill-index": Math.max(0, selectedIndex),
        } as CSSProperties
      }
    >
      <span className="m-pill-tab-indicator" aria-hidden="true" />
      {items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          tabIndex={index === selectedIndex ? 0 : -1}
          className={`m-pill-tab ${item.value === value ? "active" : ""}`}
          onClick={() => onChange(item.value)}
          onDragEnter={item.onDragEnter}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus();
            onChange(items[next].value);
          }}
        >
          {item.icon}
          <span>{item.label}</span>
          {item.count !== undefined && <small>{item.count}</small>}
        </button>
      ))}
    </div>
  );
}
